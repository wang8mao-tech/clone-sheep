import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boot, dataRoot, MP4_HEAD } from "./media-test-kit.js";

describe("GET /api/templates/:id/reference/video", () => {
  async function withSource(content: Buffer | null) {
    const ctx = await boot();
    const client = ctx.archive.createClient("客户");
    const template = ctx.archive.createTemplate(client.id, "模板");
    const workspace = template.workspace_path as string;
    if (content) {
      mkdirSync(path.join(workspace, "references", "src"), { recursive: true });
      writeFileSync(path.join(workspace, "references", "src", "source.mp4"), content);
    }
    return { ...ctx, id: template.id, workspace };
  }

  const FILE = Buffer.concat([MP4_HEAD, Buffer.alloc(988, 7)]);

  it("无 Range：200 + Accept-Ranges + 完整长度", async () => {
    const { app, id } = await withSource(FILE);
    const res = await app.inject({ method: "GET", url: `/api/templates/${id}/reference/video` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe("1000");
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.rawPayload.equals(FILE)).toBe(true);
  });

  it("有 Range：206 + Content-Range + 对应字节", async () => {
    const { app, id } = await withSource(FILE);
    const res = await app.inject({
      method: "GET",
      url: `/api/templates/${id}/reference/video`,
      headers: { range: "bytes=-100" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 900-999/1000");
    expect(res.headers["content-length"]).toBe("100");
    expect(res.rawPayload.equals(FILE.subarray(900))).toBe(true);
  });

  it("越界：416 + bytes */size，不带 Content-Type", async () => {
    const { app, id } = await withSource(FILE);
    const res = await app.inject({
      method: "GET",
      url: `/api/templates/${id}/reference/video`,
      headers: { range: "bytes=1000-" },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */1000");
    expect(res.headers["content-type"]).toBeUndefined();
  });

  it("HEAD：200 + 完整长度，不带响应体", async () => {
    const { app, id } = await withSource(FILE);
    const res = await app.inject({ method: "HEAD", url: `/api/templates/${id}/reference/video` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe("1000");
    expect(res.rawPayload.length).toBe(0);
  });

  it("source.mp4 是个目录：404 NO_SOURCE，不是 500 EISDIR（复审 Q4）", async () => {
    const { app, id, workspace } = await withSource(null);
    mkdirSync(path.join(workspace, "references", "src", "source.mp4"), { recursive: true });
    const res = await app.inject({ method: "GET", url: `/api/templates/${id}/reference/video` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NO_SOURCE" } });
  });

  it("webm 按魔数回 video/webm", async () => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60)]);
    const { app, id } = await withSource(webm);
    const res = await app.inject({ method: "GET", url: `/api/templates/${id}/reference/video` });
    expect(res.headers["content-type"]).toBe("video/webm");
  });

  it("还没有源视频：404 NO_SOURCE，不泄露路径", async () => {
    const { app, id } = await withSource(null);
    const res = await app.inject({ method: "GET", url: `/api/templates/${id}/reference/video` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NO_SOURCE" } });
    expect(res.body).not.toContain(dataRoot);
  });

  it("workspace_path 被改到数据根外：403", async () => {
    const { app, id, db } = await withSource(FILE);
    const outside = mkdtempSync(path.join(tmpdir(), "clone-studio-outside-"));
    try {
      mkdirSync(path.join(outside, "references", "src"), { recursive: true });
      writeFileSync(path.join(outside, "references", "src", "source.mp4"), "SECRET");
      db().prepare("UPDATE templates SET workspace_path = ? WHERE id = ?").run(outside, id);
      const res = await app.inject({ method: "GET", url: `/api/templates/${id}/reference/video` });
      expect(res.statusCode).toBe(403);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("references 被换成指向数据根外的 junction：403（审查 S3）", async () => {
    const { app, id, workspace } = await withSource(null);
    const outside = mkdtempSync(path.join(tmpdir(), "clone-studio-outside-"));
    try {
      mkdirSync(path.join(outside, "src"), { recursive: true });
      writeFileSync(path.join(outside, "src", "source.mp4"), "SECRET");
      rmSync(path.join(workspace, "references"), { recursive: true, force: true });
      const { symlinkSync } = await import("node:fs");
      // junction 在 Windows 上无需管理员权限；其它平台忽略 type 参数建目录符号链接
      symlinkSync(outside, path.join(workspace, "references"), "junction");
      const res = await app.inject({ method: "GET", url: `/api/templates/${id}/reference/video` });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain("SECRET");
    } finally {
      // 只拆链接本身：rmSync 对 junction 报「是目录」，recursive 又有删穿到目标的风险
      const { rmdirSync } = await import("node:fs");
      if (existsSync(path.join(workspace, "references"))) rmdirSync(path.join(workspace, "references"));
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("模板不存在：404", async () => {
    const { app } = await boot();
    const res = await app.inject({ method: "GET", url: `/api/templates/${randomUUID()}/reference/video` });
    expect(res.statusCode).toBe(404);
  });
});
