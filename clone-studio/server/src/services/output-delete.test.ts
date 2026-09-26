import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bootOutputs, useOutputsSandbox } from "./outputs-test-kit.js";

/** 删除成片（REQ-007）：删文件与封面、作废能重来的变体、复刻片不许删、只删自己的文件、不在网格里的不许删 */

useOutputsSandbox();

describe("DELETE /api/productions/:id/output", () => {
  it("删掉成片与封面、网格里消失；花费仍计入模板累计", async () => {
    const b = await bootOutputs();
    const id = b.production();
    const { output } = b.build(id, { file: "real", estimate: 0.5 });
    b.job("production", id, 0.8);
    b.outputs.listOutputs(b.template.id); // 后台抽出封面
    await b.meta.metaIdle();
    expect(existsSync(b.meta.coverPathFor(output))).toBe(true);
    const server = await b.app();
    const res = await server.inject({ method: "DELETE", url: `/api/productions/${id}/output` });
    expect(res.json()).toEqual({ removed: 2, skipped: 0 });
    expect(existsSync(output)).toBe(false);
    expect(existsSync(b.meta.coverPathFor(output))).toBe(false);
    expect(b.outputs.listOutputs(b.template.id)).toEqual([]);
    expect(b.archive.templateStats(b.archive.requireTemplate(b.template.id)).totalCostUsd).toBeCloseTo(1.3);
    expect((await server.inject({ url: `/api/productions/${id}/video` })).statusCode).toBe(404);
    expect((await server.inject({ method: "DELETE", url: `/api/productions/${id}/output` })).statusCode).toBe(404);
    await server.close();
  });

  it("删掉失败的成片 = 作废它：不能再重试出片，模板的成片数不算删掉的（9.1 审查 S2-1 / S2-6）", async () => {
    const b = await bootOutputs();
    const failed = b.production({ status: "failed" });
    b.build(failed, { status: "failed", file: null });
    const done = b.production();
    b.build(done);
    expect(b.archive.templateStats(b.archive.requireTemplate(b.template.id)).outputs).toBe(1);
    b.del.deleteOutput(failed);
    b.del.deleteOutput(done);
    expect(b.d.prepare("SELECT status FROM productions WHERE id = ?").get(failed)).toEqual({ status: "cancelled" });
    expect(b.d.prepare("SELECT status FROM productions WHERE id = ?").get(done)).toEqual({ status: "done" });
    const run = await import("./build-run.js");
    expect(() => run.retryBuild(failed)).toThrow(expect.objectContaining({ code: "NOT_RETRYABLE" }));
    expect(b.archive.templateStats(b.archive.requireTemplate(b.template.id)).outputs).toBe(0);
  });

  it("③ 不能通过一版已经在 ⑤ 删掉成片的复刻片", async () => {
    const b = await bootOutputs();
    const r = b.production({ kind: "replica", name: null, runPath: "reference.svrun" });
    b.build(r);
    b.d.prepare("UPDATE templates SET status = 'awaiting_review' WHERE id = ?").run(b.template.id);
    b.del.deleteOutput(r);
    const review = await import("./review.js");
    expect(() => review.approveReplica(b.template.id, r)).toThrow(expect.objectContaining({ code: "OUTPUT_DELETED" }));
    // ③ 也不再给「通过」与播放地址（9.1 第二轮审查 S2-M2）
    const state = review.reviewState(b.template.id);
    expect(state.approvable).toBe(false);
    expect(state.versions.at(-1)).toMatchObject({ id: r, outputDeleted: true, videoUrl: null });
  });

  it("失败的复刻片（模板流水线的头）不能在 ⑤ 删：409，之后照样能重试出片（9.1 第三轮审查 S2-H1）", async () => {
    const b = await bootOutputs();
    const r = b.production({ kind: "replica", name: null, status: "failed", runPath: "reference.svrun" });
    b.build(r, { status: "failed", file: null });
    b.d.prepare("UPDATE templates SET status = 'cloning' WHERE id = ?").run(b.template.id);
    expect(() => b.del.deleteOutput(r)).toThrow(expect.objectContaining({ code: "REPLICA_IN_FLIGHT", status: 409 }));
    expect(b.d.prepare("SELECT status, output_deleted_at FROM productions WHERE id = ?").get(r)).toEqual({
      status: "failed",
      output_deleted_at: null,
    });
    const run = await import("./build-run.js");
    vi.spyOn(await import("./estimate-run.js"), "estimateProduction").mockResolvedValue({} as never);
    expect(run.retryBuild(r)).toEqual({ queued: true });
  });

  it("本来就没有的文件不算「删掉」：失败的变体没有成片文件，removed 是 0", async () => {
    const b = await bootOutputs();
    const id = b.production({ status: "failed" });
    b.build(id, { status: "failed", file: null });
    expect(b.del.deleteOutput(id)).toEqual({ removed: [], skipped: [] });
  });

  it("成片路径是指到外面目录的 junction：只拆 junction，外面的目录和文件都在", async () => {
    const b = await bootOutputs();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "cs-outside-"));
    writeFileSync(path.join(outsideDir, "keep.txt"), "keep", "utf8");
    const link = path.join(b.workspace, "output", "junction.mp4");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(outsideDir, link, "junction");
    const id = b.production();
    b.build(id, { file: null, outputPath: link });
    expect(b.del.deleteOutput(id).removed).toContain(link);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(path.join(outsideDir, "keep.txt"), "utf8")).toBe("keep");
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("流水线里的不许删（409），文件不动", async () => {
    const b = await bootOutputs();
    const id = b.production({ status: "building" });
    const { output } = b.build(id, { status: "running" });
    await expect(async () => b.del.deleteOutput(id)).rejects.toMatchObject({ status: 409, code: "OUTPUT_BUSY" });
    expect(existsSync(output)).toBe(true);
  });

  it("只删这一条自己的：台账指到数据根外的文件不删；硬链接只删目录项，外面的内容还在", async () => {
    const b = await bootOutputs();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "cs-outside-"));
    const outside = path.join(outsideDir, "keep.mp4");
    writeFileSync(outside, "keep me", "utf8");
    const pointed = b.production();
    b.build(pointed, { file: null, outputPath: outside });
    const linked = b.production();
    const inside = path.join(b.workspace, "output", "linked.mp4");
    mkdirSync(path.dirname(inside), { recursive: true });
    linkSync(outside, inside);
    b.build(linked, { file: null, outputPath: inside });

    expect(b.del.deleteOutput(pointed).skipped).toContain(outside);
    expect(b.del.deleteOutput(linked).removed).toContain(inside);
    expect(existsSync(inside)).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("keep me");
    rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe("删除只对网格里的成片", () => {
  it("写稿阶段熔断的变体（不在网格里）：404，状态不变；删变体时 ④ 也收到推送（9.1 第四轮审查 S1-L1 / S2-L1）", async () => {
    const b = await bootOutputs();
    const hidden = b.production({ status: "tripped", runPath: null });
    expect(() => b.del.deleteOutput(hidden)).toThrow(
      expect.objectContaining({ code: "OUTPUT_NOT_FOUND", status: 404 }),
    );
    expect(b.d.prepare("SELECT status, output_deleted_at FROM productions WHERE id = ?").get(hidden)).toEqual({
      status: "tripped",
      output_deleted_at: null,
    });

    const id = b.production();
    b.build(id);
    const sse = await import("../lib/sse.js");
    const published = vi.spyOn(sse.sseHub, "publish");
    const server = await b.app();
    expect((await server.inject({ method: "DELETE", url: `/api/productions/${id}/output` })).statusCode).toBe(200);
    const events = published.mock.calls.map((c) => c[1]);
    expect(events).toEqual(expect.arrayContaining(["outputs", "variants"]));
    await server.close();
  });
});
