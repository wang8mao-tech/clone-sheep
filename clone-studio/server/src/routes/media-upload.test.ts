import path from "node:path";
import { describe, expect, it } from "vitest";
import { boot, dataRoot, MP4_HEAD, multipart, UPLOAD_LIMIT, uploadsLeft, type Part } from "./media-test-kit.js";

describe("POST /api/uploads", () => {
  it("落盘成功，返回 uuid 路径与字节数，原名不参与路径", async () => {
    const { app } = await boot();
    const body = multipart([{ name: "file", filename: "..\\..\\x.mp4", content: MP4_HEAD }]);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode).toBe(200);
    const json = res.json<{ uploadPath: string; size: number }>();
    expect(path.dirname(json.uploadPath)).toBe(path.join(dataRoot, "uploads"));
    expect(path.basename(json.uploadPath)).toMatch(/^[0-9a-f-]{36}\.mp4$/);
    expect(json.size).toBe(MP4_HEAD.length);
  });

  it("没有文件：400 NO_FILE", async () => {
    const { app } = await boot();
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...multipart([{ name: "x", content: "1" }]) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "NO_FILE" } });
  });

  it("不是 multipart：400，不是 500", async () => {
    const { app } = await boot();
    const res = await app.inject({ method: "POST", url: "/api/uploads", payload: { a: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "NOT_MULTIPART" } });
  });

  it("扩展名不对：400 BAD_FILE_TYPE，不落盘", async () => {
    const { app } = await boot();
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads",
      ...multipart([{ name: "file", filename: "a.txt", content: "hi", type: "text/plain" }]),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "BAD_FILE_TYPE" } });
    expect(uploadsLeft()).toEqual([]);
  });

  it("0 字节：400 EMPTY_FILE，并清掉落盘的空文件", async () => {
    const { app } = await boot();
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads",
      ...multipart([{ name: "file", filename: "a.mp4", content: Buffer.alloc(0) }]),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "EMPTY_FILE" } });
    expect(uploadsLeft()).toEqual([]);
  });

  it("超限：413 FILE_TOO_LARGE，截断前写进去的字节被清掉", async () => {
    const { app } = await boot();
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads",
      ...multipart([{ name: "file", filename: "a.mp4", content: Buffer.alloc(UPLOAD_LIMIT + 1) }]),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: "FILE_TOO_LARGE" } });
    expect(uploadsLeft()).toEqual([]);
  });

  // 审查 S1：原来 fields:0 时这几种请求会挂死或 500 Premature close，还留下半截文件
  it("文件前带一个普通字段：照常落盘", async () => {
    const { app } = await boot();
    const body = multipart([
      { name: "language", content: "zh" },
      { name: "file", filename: "a.mp4", content: MP4_HEAD },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode).toBe(200);
    expect(uploadsLeft()).toHaveLength(1);
  });

  it("文件后带一个普通字段：照常落盘", async () => {
    const { app } = await boot();
    const body = multipart([
      { name: "file", filename: "a.mp4", content: Buffer.alloc(32 * 1024, 1) },
      { name: "language", content: "zh" },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode).toBe(200);
    expect(uploadsLeft()).toHaveLength(1);
  });

  it("带两个文件：只收第一个，第二个排空不落盘", async () => {
    const { app } = await boot();
    const body = multipart([
      { name: "file", filename: "a.mp4", content: MP4_HEAD },
      { name: "file", filename: "b.mp4", content: Buffer.alloc(32 * 1024, 2) },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ filename: "a.mp4", size: MP4_HEAD.length });
    expect(uploadsLeft()).toHaveLength(1);
  });
});

describe("POST /api/uploads · 坏掉的 multipart（复审 Q1–Q3）", () => {
  /** 砍掉结尾的边界：模拟客户端发到一半的请求体 */
  function truncated(parts: Part[], cut: number): { payload: Buffer; headers: Record<string, string> } {
    const body = multipart(parts);
    return { ...body, payload: body.payload.subarray(0, body.payload.length - cut) };
  }

  it("请求体在文件中间截断：400 BAD_MULTIPART，不挂、不留文件", async () => {
    const { app } = await boot();
    const body = truncated([{ name: "file", filename: "a.mp4", content: Buffer.alloc(32 * 1024, 1) }], 1024);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "BAD_MULTIPART" } });
    expect(uploadsLeft()).toEqual([]);
  });

  it("小文件完整但缺结尾边界：400，不挂、不留文件", async () => {
    const { app } = await boot();
    const body = truncated([{ name: "file", filename: "a.mp4", content: MP4_HEAD }], 4);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode).toBe(400);
    // 这条走的是「流已被销毁、跳过」的分支：只断言 400 的话，插件若先交一个 null
    // 再交错误，结果会变成 NO_FILE 而用例照样绿（复审 #3）
    expect(res.json()).toMatchObject({ error: { code: "BAD_MULTIPART" } });
    expect(uploadsLeft()).toEqual([]);
  });

  it("两个小文件且请求体截断（排空路径）：400，不挂、不留文件", async () => {
    const { app } = await boot();
    const body = truncated(
      [
        { name: "file", filename: "a.mp4", content: MP4_HEAD },
        { name: "file", filename: "b.mp4", content: MP4_HEAD },
      ],
      4,
    );
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "BAD_MULTIPART" } });
    expect(uploadsLeft()).toEqual([]);
  });

  const fields = (n: number): Part[] => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, content: "x" }));

  it("字段数在上限内：照常落盘", async () => {
    const { app, media } = await boot();
    const { MAX_FIELDS } = media;
    const body = multipart([{ name: "file", filename: "a.mp4", content: MP4_HEAD }, ...fields(MAX_FIELDS)]);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode).toBe(200);
    expect(uploadsLeft()).toHaveLength(1);
  });

  // 复审 #1：插件把每个字段都攒在内存里，字段数不设顶一条请求就能把后端撑爆。
  // 上限必须自己数——插件的 parts / fields 上限一触发就是挂死（复审 Q1）
  it("文件后跟 1000 个字段：400 TOO_MANY_FIELDS，不挂、已落盘的文件被清掉", async () => {
    const { app } = await boot();
    const body = multipart([{ name: "file", filename: "a.mp4", content: MP4_HEAD }, ...fields(1000)]);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "TOO_MANY_FIELDS" } });
    expect(uploadsLeft()).toEqual([]);
  });

  it("文件前先来一堆字段：同样 400，不落盘", async () => {
    const { app, media } = await boot();
    const { MAX_FIELDS } = media;
    const body = multipart([...fields(MAX_FIELDS + 1), { name: "file", filename: "a.mp4", content: MP4_HEAD }]);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "TOO_MANY_FIELDS" } });
    expect(uploadsLeft()).toEqual([]);
  });
});
