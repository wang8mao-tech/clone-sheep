import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import type { MultipartFile, MultipartValue } from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { paths } from "../config.js";
import { requireTemplate } from "../services/archive.js";
import { EvidenceError } from "../services/evidence-types.js";
import { sourcePathOf } from "../services/evidence-steps.js";
import { archiveErrorHandler } from "./errors.js";
import { sendVideoFile } from "./video-file.js";
import { abandonRequest, discard, drain, formatMb, uploadError } from "./upload-io.js";

export { ABANDON_GRACE_MS } from "./upload-io.js";

/**
 * 参考视频的上传与播放。
 *
 * 上传落到 `<dataRoot>/uploads/`，前端拿返回的 `uploadPath` 去调
 * `POST /api/templates/:id/evidence`——证据流水线只接受这个目录里的文件
 * （见 evidence-steps 的 assertInsideUploads），两边是同一条约定。
 */

/**
 * `@fastify/multipart` 的类型在 pnpm 下是残的：它把 `fastify` 只写进
 * devDependencies，而 pnpm 不为传递依赖安装 devDependencies——它自己的
 * node_modules 里没有 fastify。于是它 d.ts 里的 `import ... from "fastify"`
 * 解析失败，连带两件事：
 *   1. `declare module "fastify"` 增强不到我们这份 fastify，`request.parts()`
 *      在类型上不存在；
 *   2. 插件自身的类型退化成 error 类型，注册时 eslint 报 no-unsafe-argument
 *      （Phase 5 装 Agent SDK 后依赖树重排，这一条已不再出现，豁免随之删掉）。
 *
 * 试过 `public-hoist-pattern[]=fastify`，没用——没有可提升的东西。剩下的选择
 * 是 shamefully-hoist（全局副作用）或在这里把用到的部分显式声明出来。取后者：
 * 影响面只有这一个文件，运行时行为不受影响（插件注册后方法确实挂上去了）。
 */
type MultipartRequest = FastifyRequest & {
  parts: () => AsyncIterableIterator<MultipartFile | MultipartValue>;
};

/** REQ-002 输入表：≤500 MB */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/**
 * 一条上传请求最多带多少个非文件字段。我们一个字段也不读，但插件会把每个字段
 * 攒进内存直到请求结束——不设顶的话 60 万个 1 KB 字段能把后端撑到近 1 GB
 * （复审 #1 实测）。multipart 是 CORS 简单请求，浏览器里任何网页都能不经预检
 * 往 127.0.0.1 发。上限只能自己数：插件的 parts / fields 上限一触发就挂死。
 */
export const MAX_FIELDS = 100;

/** REQ-002 输入表：mp4/mov/webm */
const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);

export interface MediaOptions {
  /** 测试用：不真发 500 MB 也能走到 413 */
  maxUploadBytes?: number;
}

export async function mediaRoutes(app: FastifyInstance, opts: MediaOptions): Promise<void> {
  const maxBytes = opts.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  app.setErrorHandler(archiveErrorHandler);

  await app.register(multipart, {
    // 只限单个文件的大小，fields / files 不设、parts 显式放开：插件在触发这几个
    // 上限时会 unpipe 请求并销毁当前文件流，结果是请求挂死或 500 Premature close，
    // 半截文件还留在盘上（Task 4.3 审查 S1 实测）。parts 不写的话插件会强塞一个
    // 1000 的默认值（index.js `limits.parts || 1000`），同样走那条路。
    // 多余的文件由下面的循环排空丢弃，字段数由循环自己数（MAX_FIELDS）；
    // 字段值截到 1 KB，我们一个字段也不读。
    // throwFileSizeLimit 关掉：超限走 file.truncated，我们自己清盘再报 413
    limits: { fileSize: maxBytes, fieldSize: 1024, parts: Infinity },
    throwFileSizeLimit: false,
  });

  /**
   * 上传参考视频。整段流式落盘，绝不先读进内存——500MB 的文件读进来就是
   * 500MB 常驻，单机工具没有这个余量。
   *
   * 把每个 part 都读完：只收第一个文件，之后的文件与所有字段一律排空。
   * 不读完的话 busboy 停在那里，请求永远收不到结尾。
   */
  app.post("/api/uploads", async (request, reply) => {
    let saved: { target: string; filename: string } | undefined;
    let rejected: EvidenceError | undefined;
    let writing: string | undefined;
    let fields = 0;

    // 目录必须在开始解析之前建好：拿到文件 part 之后再 await，小请求体会在这段
    // 空当里被 busboy 解析完、流被插件销毁，而 pipeline 对一个已销毁且从没读过的
    // 流永远不会返回——请求挂死、fd 与半截文件一直留着（复审 Q1）
    try {
      await mkdir(paths.uploads, { recursive: true });
      for await (const part of (request as MultipartRequest).parts()) {
        if (part.type !== "file") {
          fields += 1;
          if (fields > MAX_FIELDS) {
            throw new EvidenceError("TOO_MANY_FIELDS", `上传请求里的字段太多（超过 ${MAX_FIELDS} 个）。`, 400);
          }
          continue;
        }
        if (saved || rejected) {
          await drain(part);
          continue;
        }
        const ext = path.extname(part.filename || "").toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          rejected = new EvidenceError(
            "BAD_FILE_TYPE",
            `只收 ${[...ALLOWED_EXTENSIONS].join(" / ")}，收到的是「${ext || "无扩展名"}」。`,
            400,
          );
          await drain(part);
          continue;
        }

        // 插件已经销毁了这个流（请求体坏了、客户端断了）：别去接它，错误会在
        // 下一轮迭代由插件抛出来。判断和接流在同一个同步段里，中间插不进销毁
        if (part.file.destroyed) continue;
        // 文件名用 uuid：用户的原名可能带路径分隔符或别的花样，不让它参与路径
        writing = path.join(paths.uploads, `${randomUUID()}${ext}`);
        await pipeline(part.file, createWriteStream(writing));
        // 插件是流式掐断的，超限时前面的字节已经写进去了，必须自己清
        if (part.file.truncated) {
          await rm(writing, { force: true });
          rejected = new EvidenceError("FILE_TOO_LARGE", `文件超过 ${formatMb(maxBytes)}。`, 413);
        } else {
          saved = { target: writing, filename: part.filename };
        }
        writing = undefined;
      }
    } catch (error) {
      // 提前离开了循环，请求体可能还没读完：必须先把连接交代掉再回错
      abandonRequest(request, reply);
      // 客户端中途断开、multipart 格式坏了……落了一半的、已经落完的都不要了
      await discard(request, writing);
      await discard(request, saved?.target);
      const mapped = uploadError(error);
      if (mapped instanceof EvidenceError && mapped.code === "UPLOAD_IO") request.log.error(error, "上传落盘失败");
      throw mapped;
    }

    if (rejected) {
      if (saved) await rm(saved.target, { force: true });
      throw rejected;
    }
    if (!saved) throw new EvidenceError("NO_FILE", "没有收到文件。", 400);

    const { size } = await stat(saved.target);
    if (size === 0) {
      await rm(saved.target, { force: true });
      throw new EvidenceError("EMPTY_FILE", "这是一个空文件。", 400);
    }
    return { uploadPath: saved.target, filename: saved.filename, size };
  });

  /**
   * 播放参考视频。**必须支持 Range**：播放器拖进度条靠的就是它，
   * 不支持的话只能从头播。
   */
  app.get("/api/templates/:id/reference/video", async (request, reply) => {
    const { id } = request.params as { id: string };
    const template = requireTemplate(id);
    if (!template.workspace_path) {
      throw new EvidenceError("NO_WORKSPACE", "这个模板没有工作目录。", 404);
    }
    return sendVideoFile(
      request,
      reply,
      sourcePathOf(template.workspace_path),
      new EvidenceError("NO_SOURCE", "这个模板还没有参考视频。", 404),
    );
  });
}
