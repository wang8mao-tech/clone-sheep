import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import type { MultipartFile, MultipartValue } from "@fastify/multipart";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { paths } from "../config.js";
import { EvidenceError } from "../services/evidence-types.js";
import {
  approveAssets,
  assertReplaceable,
  assetFile,
  replaceAsset,
  rerunVariant,
  reviewState,
  reworkVariant,
} from "../services/variant-review.js";
import { VariantError } from "../services/variants.js";
import { archiveErrorHandler } from "./errors.js";
import { abandonRequest, discard, drain, formatMb, uploadError } from "./upload-io.js";

/** 见 media.ts 的说明：@fastify/multipart 的类型在 pnpm 下是残的，这里显式声明用到的部分 */
type MultipartRequest = FastifyRequest & {
  parts: () => AsyncIterableIterator<MultipartFile | MultipartValue>;
};

/** REQ-005 输入表：替换图 jpg / png / webp，≤20 MB */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const MAX_FIELDS = 100;

const ReworkBody = z.object({ note: z.string() });

function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof VariantError) {
    void reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    return;
  }
  archiveErrorHandler(error, request, reply);
}

export interface VariantAssetOptions {
  /** 测试用：不真发 20 MB 也能走到 413 */
  maxImageBytes?: number;
}

/** 素材审核（REQ-005、SCREEN-007）：审核状态、素材图、替换单张、素材通过、打回、重跑 */
export async function variantAssetRoutes(app: FastifyInstance, opts: VariantAssetOptions): Promise<void> {
  const maxBytes = opts.maxImageBytes ?? MAX_IMAGE_BYTES;
  app.setErrorHandler(errorHandler);
  // 与 media.ts 同样的取舍：只限单文件大小，超限走 truncated 自己清盘报 413（插件的 parts / fields 上限会挂死请求）
  await app.register(multipart, {
    limits: { fileSize: maxBytes, fieldSize: 1024, parts: Infinity },
    throwFileSizeLimit: false,
  });

  app.get("/api/variants/:id/review", async (request) => {
    const { id } = request.params as { id: string };
    return reviewState(id);
  });

  app.get("/api/assets/:id/file", async (request, reply) => {
    const { id } = request.params as { id: string };
    const file = assetFile(id);
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const { size } = await stat(file);
    return reply
      .header("content-type", type)
      .header("content-length", size)
      .header("cache-control", "no-cache")
      .header("x-content-type-options", "nosniff")
      .send(createReadStream(file));
  });

  /** 替换单张：一个文件字段；落到 uploads/ 再交给服务转换写回，转换完上传文件就删 */
  app.post("/api/assets/:id/replace", async (request, reply) => {
    const { id } = request.params as { id: string };
    let saved: string | undefined;
    let writing: string | undefined;
    let rejected: EvidenceError | undefined;
    let fields = 0;
    // 不能换（素材不在、不在素材待审）就别收文件：先判再读请求体（8.2 审查 L4）
    try {
      assertReplaceable(id);
    } catch (error) {
      abandonRequest(request, reply);
      throw error;
    }
    try {
      await mkdir(paths.uploads, { recursive: true });
      for await (const part of (request as MultipartRequest).parts()) {
        if (part.type !== "file") {
          fields += 1;
          if (fields > MAX_FIELDS) throw new EvidenceError("TOO_MANY_FIELDS", "上传请求里的字段太多。", 400);
          continue;
        }
        if (saved || rejected) {
          await drain(part);
          continue;
        }
        const ext = path.extname(part.filename || "").toLowerCase();
        if (!IMAGE_TYPES[ext]) {
          rejected = new EvidenceError(
            "BAD_FILE_TYPE",
            `只收 jpg / png / webp，收到的是「${ext || "无扩展名"}」。`,
            400,
          );
          await drain(part);
          continue;
        }
        if (part.file.destroyed) continue;
        writing = path.join(paths.uploads, `${randomUUID()}${ext}`);
        await pipeline(part.file, createWriteStream(writing));
        if (part.file.truncated) {
          await rm(writing, { force: true });
          rejected = new EvidenceError("FILE_TOO_LARGE", `图片超过 ${formatMb(maxBytes)}。`, 413);
        } else {
          saved = writing;
        }
        writing = undefined;
      }
    } catch (error) {
      abandonRequest(request, reply);
      await discard(request, writing);
      await discard(request, saved);
      throw uploadError(error);
    }
    if (rejected) {
      await discard(request, saved);
      throw rejected;
    }
    if (!saved) throw new EvidenceError("NO_FILE", "没有收到图片。", 400);
    return { asset: await replaceAsset(id, saved) };
  });

  app.post("/api/variants/:id/approve", async (request) => {
    const { id } = request.params as { id: string };
    return approveAssets(id);
  });

  app.post("/api/variants/:id/rework", async (request) => {
    const { id } = request.params as { id: string };
    const body = ReworkBody.parse(request.body);
    return reworkVariant(id, body.note);
  });

  app.post("/api/variants/:id/rerun", async (request) => {
    const { id } = request.params as { id: string };
    return { variant: rerunVariant(id) };
  });
}
