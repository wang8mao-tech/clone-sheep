import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bootOutputs, useOutputsSandbox } from "./outputs-test-kit.js";

/** ⑤ 成片的文件操作（REQ-007、AC-020 / AC-021）：打包 zip、删除成片、下载 */

useOutputsSandbox();

/** 用系统的 tar（bsdtar，认 zip）解包：不拿自己写的解析器验自己写的 zip */
function unzip(buf: Buffer): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-unzip-"));
  try {
    writeFileSync(path.join(dir, "a.zip"), buf);
    mkdirSync(path.join(dir, "x"));
    // Windows 上用系统自带的 bsdtar（PATH 里可能先碰到 Git 的 GNU tar，它不认 zip、还把 C: 当主机名）
    const tar =
      process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe") : "tar";
    const out = spawnSync(tar, ["-xf", "a.zip", "-C", "x"], { cwd: dir, windowsHide: true });
    if (out.status !== 0) throw new Error(`tar 解不开：${String(out.stderr)}`);
    return Object.fromEntries(
      readdirSync(path.join(dir, "x")).map((f) => [f, readFileSync(path.join(dir, "x", f), "utf8")]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("文件名", () => {
  it("Windows 不允许的字符换成 _、去掉结尾点和空格、设备名加前缀、空的用「成片」", async () => {
    const b = await bootOutputs();
    expect(b.zip.safeFileStem('a/b\\c:d*e?"f<g>h|i')).toBe("a_b_c_d_e__f_g_h_i");
    expect(b.zip.safeFileStem("结尾. . ")).toBe("结尾");
    expect(b.zip.safeFileStem("CON")).toBe("_CON");
    expect(b.zip.safeFileStem("  ")).toBe("成片");
    expect(b.zip.uniqueNames(["榜", "榜", "top", "Top"])).toEqual(["榜.mp4", "榜 (2).mp4", "top.mp4", "Top (2).mp4"]);
  });
});

describe("整包大小上限", () => {
  it("不写 ZIP64：超过 4 GB（算上每条的头）或超过 65535 条就拒绝", async () => {
    const b = await bootOutputs();
    const big = 0xffffffff - 22 - 76 - 2 * Buffer.byteLength("a.mp4");
    expect(() => b.zip.checkZipSize([{ name: "a.mp4", size: big }])).not.toThrow();
    expect(() => b.zip.checkZipSize([{ name: "a.mp4", size: big + 1 }])).toThrow(
      expect.objectContaining({ code: "ZIP_TOO_LARGE", status: 413 }),
    );
    const many = Array.from({ length: 0x10000 }, (_, i) => ({ name: `${i}.mp4`, size: 1 }));
    expect(() => b.zip.checkZipSize(many)).toThrow(expect.objectContaining({ code: "ZIP_TOO_LARGE" }));
  });
});

describe("GET /api/templates/:id/outputs/zip", () => {
  it("AC-021：勾 3 条 → zip 里 3 个 mp4、以成片名命名，重名加序号、非法字符替换，内容原样", async () => {
    const b = await bootOutputs();
    const a = b.production({ name: "手机/拍照榜" });
    b.build(a, { file: "AAAA" });
    const c = b.production({ name: "平板榜" });
    b.build(c, { file: "CCCCCC" });
    const d = b.production({ name: "平板榜" });
    b.build(d, { file: "DD" });
    const server = await b.app();
    const res = await server.inject({ url: `/api/templates/${b.template.id}/outputs/zip?ids=${a},${c},${d}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent("手机榜.zip")}`);
    expect(unzip(res.rawPayload)).toEqual({
      "手机_拍照榜.mp4": "AAAA",
      "平板榜.mp4": "CCCCCC",
      "平板榜 (2).mp4": "DD",
    });
    await server.close();
  });

  it("没勾 400；有一条没出完 409 并说是哪条；别的模板的、删过的 404", async () => {
    const b = await bootOutputs();
    const ok = b.production({ name: "好的" });
    b.build(ok);
    const running = b.production({ name: "渲染中的", status: "building" });
    b.build(running, { status: "running", file: null });
    const other = b.archive.createTemplate(b.template.client_id, "别的");
    const foreign = b.production({ templateId: other.id });
    b.build(foreign);
    const server = await b.app();
    const url = (ids: string) => `/api/templates/${b.template.id}/outputs/zip?ids=${ids}`;
    expect((await server.inject({ url: url("") })).json().error.code).toBe("NOTHING_SELECTED");
    const busy = await server.inject({ url: url(`${ok},${running}`) });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.message).toContain("渲染中的");
    expect((await server.inject({ url: url(`${ok},${foreign}`) })).statusCode).toBe(404);
    b.d.prepare("UPDATE productions SET output_deleted_at = 'x' WHERE id = ?").run(ok);
    expect((await server.inject({ url: url(ok) })).statusCode).toBe(404);
    await server.close();
  });

  it("台账里的成片路径指到数据根外面：不打包，409", async () => {
    const b = await bootOutputs();
    const outside = path.join(mkdtempSync(path.join(tmpdir(), "cs-outside-")), "x.mp4");
    writeFileSync(outside, "secret", "utf8");
    const id = b.production();
    b.build(id, { file: null, outputPath: outside });
    const server = await b.app();
    const res = await server.inject({ url: `/api/templates/${b.template.id}/outputs/zip?ids=${id}` });
    expect(res.statusCode).toBe(409);
    await server.close();
    rmSync(path.dirname(outside), { recursive: true, force: true });
  });
});

describe("GET /api/productions/:id/video：删过成片的", () => {
  it("库里标了删除：不管文件在不在都不给播放和下载（防御：只认标记）", async () => {
    const b = await bootOutputs();
    const id = b.production();
    b.build(id, { file: "fake mp4" });
    b.d.prepare("UPDATE productions SET output_deleted_at = 'x' WHERE id = ?").run(id);
    const server = await b.app();
    const res = await server.inject({ url: `/api/productions/${id}/video` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NO_OUTPUT");
    await server.close();
  });
});

describe("GET /api/productions/:id/video?download=1", () => {
  it("AC-020：以成片名下载（UTF-8 文件名），不带参数是播放", async () => {
    const b = await bootOutputs();
    const id = b.production({ name: "国产手机:拍照榜" });
    b.build(id, { file: "fake mp4" });
    const server = await b.app();
    const dl = await server.inject({ url: `/api/productions/${id}/video?download=1` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-disposition"]).toBe(
      `attachment; filename="output.mp4"; filename*=UTF-8''${encodeURIComponent("国产手机_拍照榜.mp4")}`,
    );
    const play = await server.inject({ url: `/api/productions/${id}/video` });
    expect(play.headers["content-disposition"]).toBeUndefined();
    // 文件不在：404 的错误不能带着下载头，不然浏览器会把错误 JSON 存成 mp4
    b.d.prepare("UPDATE builds SET status = 'failed' WHERE production_id = ?").run(id);
    const gone = await server.inject({ url: `/api/productions/${id}/video?download=1` });
    expect(gone.statusCode).toBe(404);
    expect(gone.headers["content-disposition"]).toBeUndefined();
    await server.close();
  });
});

describe("GET /api/productions/:id/cover、PATCH、costs 路由", () => {
  it("封面：有就给 jpeg，没有 404；改名与花费走得通", async () => {
    const b = await bootOutputs();
    const id = b.production();
    b.build(id, { file: "real" });
    const server = await b.app();
    expect((await server.inject({ url: `/api/productions/${id}/cover` })).statusCode).toBe(404);
    await server.inject({ url: `/api/templates/${b.template.id}/outputs` });
    await b.meta.metaIdle();
    const cover = await server.inject({ url: `/api/productions/${id}/cover` });
    expect(cover.statusCode).toBe(200);
    expect(cover.headers["content-type"]).toBe("image/jpeg");
    const renamed = await server.inject({
      method: "PATCH",
      url: `/api/productions/${id}`,
      payload: { name: " 新名 " },
    });
    expect(renamed.json()).toEqual({ id, name: "新名" });
    expect((await server.inject({ method: "PATCH", url: `/api/productions/${id}`, payload: {} })).statusCode).toBe(400);
    expect((await server.inject({ url: `/api/productions/${id}/costs` })).json()).toMatchObject({ productionId: id });
    await server.close();
  });
});

describe("封面路由的失败路径", () => {
  it("缓存了封面、文件被删了：404 NO_COVER，不是 500；封面指到数据根外：404", async () => {
    const b = await bootOutputs();
    const id = b.production();
    const { output } = b.build(id, { file: "real" });
    b.outputs.listOutputs(b.template.id);
    await b.meta.metaIdle();
    rmSync(b.meta.coverPathFor(output));
    const server = await b.app();
    const gone = await server.inject({ url: `/api/productions/${id}/cover` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe("NO_COVER");
    const outside = path.join(mkdtempSync(path.join(tmpdir(), "cs-outside-")), "x.jpg");
    writeFileSync(outside, "jpeg", "utf8");
    b.d.prepare("UPDATE builds SET cover_path = ? WHERE production_id = ?").run(outside, id);
    expect((await server.inject({ url: `/api/productions/${id}/cover` })).statusCode).toBe(404);
    await server.close();
    rmSync(path.dirname(outside), { recursive: true, force: true });
  });
});

describe("Content-Disposition", () => {
  it("RFC 5987：' ( ) * 也编码", async () => {
    const { attachment } = await import("../lib/content-disposition.js");
    expect(attachment("it's (A)*.mp4", "x.mp4")).toBe(
      `attachment; filename="x.mp4"; filename*=UTF-8''it%27s%20%28A%29%2A.mp4`,
    );
  });
});

describe("PATCH 的推送", () => {
  it("改变体的名：⑤ 与 ④ 都收到；改复刻片的名：只推 ⑤（9.1 第五轮审查 S2-L2）", async () => {
    const b = await bootOutputs();
    const v = b.production();
    b.build(v);
    const r = b.production({ kind: "replica", name: null, runPath: "reference.svrun" });
    b.build(r);
    const sse = await import("../lib/sse.js");
    const published = vi.spyOn(sse.sseHub, "publish");
    const server = await b.app();
    await server.inject({ method: "PATCH", url: `/api/productions/${v}`, payload: { name: "变体新名" } });
    expect(published.mock.calls.map((c) => c[1])).toEqual(["outputs", "variants"]);
    published.mockClear();
    await server.inject({ method: "PATCH", url: `/api/productions/${r}`, payload: { name: "复刻新名" } });
    expect(published.mock.calls.map((c) => c[1])).toEqual(["outputs"]);
    await server.close();
  });
});
