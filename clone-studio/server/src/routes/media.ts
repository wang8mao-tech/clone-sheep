import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import multipart from "@fastify/multipart";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { paths } from "../config.js";
import { requireTemplate } from "../services/archive.js";
import { EvidenceError } from "../services/evidence-types.js";
import { sourcePathOf } from "../services/evidence-steps.js";
import { archiveErrorHandler } from "./errors.js";
import { parseRange } from "./range.js";

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
 *   1. `declare module "fastify"` 增强不到我们这份 fastify，`request.file()`
 *      在类型上不存在；
 *   2. 插件自身的类型退化成 error 类型，注册时 eslint 报 no-unsafe-argument。
 *
 * 试过 `public-hoist-pattern[]=fastify`，没用——没有可提升的东西。剩下的选择
 * 是 shamefully-hoist（全局副作用）或在这里把用到的部分显式声明出来。取后者：
 * 影响面只有这一个文件，运行时行为不受影响（插件注册后方法确实挂上去了）。
 */
type MultipartRequest = FastifyRequest & {
  file: () => Promise<MultipartFile | undefined>;
};

/** REQ-002 输入表：≤500 MB */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** REQ-002 输入表：mp4/mov/webm */
const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(archiveErrorHandler);

  // 见上：插件类型在 pnpm 下退化成 error 类型，这里的 disable 是它的直接后果，
  // 不是在掩盖真实的类型问题
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  await app.register(multipart, {
    // 交给插件在流上限流，而不是自己数字节：超限时它会直接掐断，
    // 不会先把 500MB 收进来再说
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 },
  });

  /**
   * 上传参考视频。整段流式落盘，绝不先读进内存——500MB 的文件读进来就是
   * 500MB 常驻，单机工具没有这个余量。
   */
  app.post("/api/uploads", async (request) => {
    const part = await (request as MultipartRequest).file();
    if (!part) throw new EvidenceError("NO_FILE", "没有收到文件。", 400);

    const ext = path.extname(part.filename || "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new EvidenceError(
        "BAD_FILE_TYPE",
        `只收 ${[...ALLOWED_EXTENSIONS].join(" / ")}，收到的是「${ext || "无扩展名"}」。`,
        400,
      );
    }

    await mkdir(paths.uploads, { recursive: true });
    // 文件名用 uuid：用户的原名可能带路径分隔符或别的花样，不让它参与路径
    const target = path.join(paths.uploads, `${randomUUID()}${ext}`);

    try {
      await pipeline(part.file, createWriteStream(target));
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }

    // 插件是流式掐断的，超限时前面的字节已经写进去了，必须自己清
    if (part.file.truncated) {
      await rm(target, { force: true });
      throw new EvidenceError("FILE_TOO_LARGE", `文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB。`, 413);
    }

    const info = await stat(target);
    return { uploadPath: target, filename: part.filename, size: info.size };
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

    const file = sourcePathOf(template.workspace_path);
    assertInsideDataRoot(file);

    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      throw new EvidenceError("NO_SOURCE", "这个模板还没有参考视频。", 404);
    }

    void reply.header("Accept-Ranges", "bytes");
    void reply.header("Content-Type", "video/mp4");
    // 工作目录里的文件会随重新导入而变，别让浏览器缓存住旧的
    void reply.header("Cache-Control", "no-store");

    const range = parseRange(request.headers.range, size);
    if (range === "invalid") {
      void reply.header("Content-Range", `bytes */${size}`);
      return reply.status(416).send();
    }
    if (!range) {
      void reply.header("Content-Length", String(size));
      return reply.send(createReadStream(file));
    }

    void reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    void reply.header("Content-Length", String(range.end - range.start + 1));
    return reply.status(206).send(createReadStream(file, { start: range.start, end: range.end }));
  });
}

/**
 * 只许读数据根目录里的东西。
 * 现在的路径是从库里的 workspace_path 拼出来的，看着安全；但那一列是可写的，
 * 而一个「按路径读文件」的接口一旦漏了这道判断，就是现成的任意文件读取。
 */
function assertInsideDataRoot(file: string): void {
  const root = path.resolve(paths.clients, "..");
  const rel = path.relative(root, path.resolve(file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new EvidenceError("OUTSIDE_DATA_ROOT", "拒绝读取数据目录之外的文件。", 403);
  }
}
