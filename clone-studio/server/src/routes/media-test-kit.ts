import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * media 路由测试的共用启动与请求体构造（Task 4.3 审查 S2）。
 *
 * 引入本模块即注册 beforeEach/afterEach：每个用例一个临时数据根目录。
 * config 在 import 时就算好数据根目录，所以必须先设环境变量、resetModules，
 * 再动态 import——顺序反了会写进用户的 ~/.clone-studio。写法与 archive.test.ts 一致。
 */
export let dataRoot: string;
let app: FastifyInstance | undefined;
let closeDb: (() => void) | undefined;

export const UPLOAD_LIMIT = 64 * 1024;

export async function boot() {
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
  const dbMod = await import("../db/index.js");
  (await import("../db/migrate.js")).migrate();
  closeDb = dbMod.closeDb;
  const archive = await import("../services/archive.js");
  const media = await import("./media.js");
  const { mediaRoutes } = media;
  const Fastify = (await import("fastify")).default;
  app = Fastify({ logger: false });
  await app.register(mediaRoutes, { maxUploadBytes: UPLOAD_LIMIT });
  await app.ready();
  return { app, archive, db: dbMod.db, media };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-media-"));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  closeDb?.();
  closeDb = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

export type Part = { name: string; content: string | Buffer; filename?: string; type?: string };

/** 手拼 multipart 体：inject 没有现成的 FormData 编码 */
export function multipart(parts: Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----cs${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = p.filename
      ? `form-data; name="${p.name}"; filename="${p.filename}"`
      : `form-data; name="${p.name}"`;
    const head = `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${p.filename ? `Content-Type: ${p.type ?? "video/mp4"}\r\n` : ""}\r\n`;
    chunks.push(
      Buffer.from(head),
      Buffer.isBuffer(p.content) ? p.content : Buffer.from(p.content),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

export function uploadsLeft(): string[] {
  const dir = path.join(dataRoot, "uploads");
  return existsSync(dir) ? readdirSync(dir) : [];
}

export const MP4_HEAD = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
