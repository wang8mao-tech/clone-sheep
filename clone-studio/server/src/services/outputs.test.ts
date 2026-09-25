import { describe, expect, it } from "vitest";
import { bootOutputs, useOutputsSandbox } from "./outputs-test-kit.js";

/** ⑤ 成片库（REQ-007、REQ-009）：网格收哪些、状态与取代、封面与时长、改名、花费明细 */

useOutputsSandbox();

describe("listOutputs：网格收哪些", () => {
  it("复刻片每一版与交给出片的变体都收；作废没出过片的、写稿前的、删过成片的不收；新的在前", async () => {
    const b = await bootOutputs();
    const r1 = b.production({ kind: "replica", name: null, version: 1, runPath: "reference.svrun" });
    b.build(r1);
    const r2 = b.production({ kind: "replica", name: null, version: 2, runPath: "reference.svrun" });
    b.build(r2);
    b.d
      .prepare("UPDATE templates SET status = 'approved', approved_replica_id = ? WHERE id = ?")
      .run(r2, b.template.id);
    const pending = b.production({ status: "awaiting_cost_confirm", name: "等确认" });
    b.production({ status: "agent_running", runPath: null, name: "写稿中" });
    b.production({ status: "cancelled", name: "作废" });
    const gone = b.production({ name: "删过" });
    b.build(gone);
    b.d.prepare("UPDATE productions SET output_deleted_at = ? WHERE id = ?").run("2026-09-25T09:00:00Z", gone);

    const list = b.outputs.listOutputs(b.template.id);
    expect(list.map((o) => o.name)).toEqual(["等确认", "复刻片 v2", "复刻片 v1"]);
    expect(list.find((o) => o.id === pending)).toMatchObject({
      status: "pending",
      productionStatus: "awaiting_cost_confirm",
      downloadable: false,
      build: null,
    });
    expect(list.find((o) => o.id === r2)).toMatchObject({ approved: true, supersededBy: null, downloadable: true });
    expect(list.find((o) => o.id === r1)).toMatchObject({ approved: false, supersededBy: 2 });
  });

  it("「已被 vN 取代」：没通过验货时按出完的最高版本；通过的那版被删了，旧版照样写被它取代", async () => {
    const b = await bootOutputs();
    const r1 = b.production({ kind: "replica", name: null, version: 1, runPath: "reference.svrun" });
    b.build(r1);
    const r2 = b.production({ kind: "replica", name: null, version: 2, runPath: "reference.svrun" });
    b.build(r2);
    expect(b.outputs.listOutputs(b.template.id).find((o) => o.id === r1)?.supersededBy).toBe(2);
    expect(b.outputs.listOutputs(b.template.id).find((o) => o.id === r2)?.supersededBy).toBeNull();

    b.d
      .prepare("UPDATE templates SET status = 'approved', approved_replica_id = ? WHERE id = ?")
      .run(r2, b.template.id);
    b.d.prepare("UPDATE productions SET output_deleted_at = 'x' WHERE id = ?").run(r2);
    expect(b.outputs.listOutputs(b.template.id)).toEqual([expect.objectContaining({ id: r1, supersededBy: 2 })]);
  });

  it("过了判据、排队 / 待确认的复刻片也列（还没出过片）；作废的不列（9.1 第三轮审查 S1-M1）", async () => {
    const b = await bootOutputs();
    const queued = b.production({
      kind: "replica",
      name: null,
      version: 1,
      status: "awaiting_cost_confirm",
      runPath: "reference.svrun",
    });
    b.production({ kind: "replica", name: null, version: 2, status: "cancelled", runPath: "reference.svrun" });
    expect(b.outputs.listOutputs(b.template.id)).toEqual([
      expect.objectContaining({ id: queued, status: "pending", build: null }),
    ]);
  });

  it("熔断的变体（出过片）算失败，不留在进行中", async () => {
    const b = await bootOutputs();
    const id = b.production({ status: "tripped" });
    b.build(id, { status: "failed", file: null });
    expect(b.outputs.listOutputs(b.template.id)[0]).toMatchObject({ status: "failed", productionStatus: "tripped" });
  });

  it("retryable 与 build/retry 同一套：出片失败能重试；重跑后（运行文件清掉）Agent 又失败、熔断都不能（9.2 第三轮审查 S1-1）", async () => {
    const b = await bootOutputs();
    const failed = b.production({ name: "出片失败", status: "failed" });
    b.build(failed, { status: "failed", file: null });
    const rerun = b.production({ name: "重跑后又失败", status: "failed", runPath: null });
    b.build(rerun, { status: "failed", file: null });
    const tripped = b.production({ name: "熔断", status: "tripped" });
    b.build(tripped, { status: "failed", file: null });
    const byName = Object.fromEntries(b.outputs.listOutputs(b.template.id).map((o) => [o.name, o.retryable]));
    expect(byName).toEqual({ 出片失败: true, 重跑后又失败: false, 熔断: false });
  });

  it("空模板给空表；模板不存在 404", async () => {
    const b = await bootOutputs();
    expect(b.outputs.listOutputs(b.template.id)).toEqual([]);
    expect(() => b.outputs.listOutputs("nope")).toThrow(
      expect.objectContaining({ status: 404, code: "TEMPLATE_NOT_FOUND" }),
    );
  });

  it("出片失败的变体：状态失败、不能下载、带着出片错误", async () => {
    const b = await bootOutputs();
    const id = b.production({ status: "failed" });
    b.build(id, { status: "failed", file: null });
    b.d
      .prepare("UPDATE builds SET error_code = 'BUILD_FAILED', error_message = '渲染炸了' WHERE production_id = ?")
      .run(id);
    const [card] = b.outputs.listOutputs(b.template.id);
    expect(card).toMatchObject({ status: "failed", downloadable: false, durationS: null, coverUrl: null });
    expect(card?.build).toMatchObject({ errorCode: "BUILD_FAILED", errorMessage: "渲染炸了" });
  });

  it("卡片花费：变体 = 自己的 Agent 任务 + 出片，标「估」；复刻片不含共用的复刻会话", async () => {
    const b = await bootOutputs();
    const v = b.production();
    b.build(v, { estimate: 0.3 });
    b.job("production", v, 0.8);
    const r = b.production({ kind: "replica", name: null, runPath: "reference.svrun" });
    b.build(r, { estimate: 0 });
    b.job("template", b.template.id, 1.2);
    const list = b.outputs.listOutputs(b.template.id);
    expect(list.find((o) => o.id === v)?.costUsd).toBeCloseTo(1.1);
    expect(list.find((o) => o.id === v)?.costIsEstimate).toBe(true);
    expect(list.find((o) => o.id === r)?.costUsd).toBe(0);
  });
});

describe("成片文件不见了", () => {
  it("台账说出完了、磁盘上没有：不能下载，也不抽帧", async () => {
    const b = await bootOutputs();
    b.build(b.production(), { file: null });
    const [card] = b.outputs.listOutputs(b.template.id);
    expect(card).toMatchObject({ status: "done", downloadable: false, coverUrl: null, durationS: null });
  });
});

describe("台账路径在数据根外", () => {
  it("卡片不给下载（与下载、打包同一个判断），也不去抽帧", async () => {
    const b = await bootOutputs();
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "cs-outside-"));
    const outside = path.join(dir, "x.mp4");
    writeFileSync(outside, "fake", "utf8");
    b.build(b.production(), { file: null, outputPath: outside });
    expect(b.outputs.listOutputs(b.template.id)[0]).toMatchObject({ downloadable: false, coverUrl: null });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("renameOutput", () => {
  it("去首尾空白存下；空的、超过 60 字的拒绝；删过成片的 404", async () => {
    const b = await bootOutputs();
    const id = b.production();
    expect(b.outputs.renameOutput(id, "  国产手机拍照榜  ").name).toBe("国产手机拍照榜");
    expect(() => b.outputs.renameOutput(id, "   ")).toThrow(expect.objectContaining({ code: "NAME_EMPTY" }));
    expect(() => b.outputs.renameOutput(id, "字".repeat(61))).toThrow(
      expect.objectContaining({ code: "NAME_TOO_LONG" }),
    );
    expect(b.outputs.renameOutput(id, "字".repeat(60)).name).toHaveLength(60);
    b.d.prepare("UPDATE productions SET output_deleted_at = 'x' WHERE id = ?").run(id);
    expect(() => b.outputs.renameOutput(id, "新名")).toThrow(expect.objectContaining({ status: 404 }));
    // 不在网格里的（写稿前的变体）也不能改
    const hidden = b.production({ status: "agent_running", runPath: null });
    expect(() => b.outputs.renameOutput(hidden, "新名")).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("outputCosts：花费明细 CMP-008", () => {
  it("AC-024：变体 1 次 Agent 任务 + 1 次出片 → 两笔、合计，两笔都标「估」", async () => {
    const b = await bootOutputs();
    const id = b.production();
    b.job("production", id, 0.8025, { elapsedMs: 220_000 });
    b.build(id, { estimate: 0.56, receiptUrl: "https://td.example/r/1" });
    const c = b.costs.outputCosts(id);
    expect(c.agent).toEqual([
      expect.objectContaining({
        model: "claude-sonnet-5",
        elapsedMs: 220_000,
        costUsd: 0.8025,
        isEstimate: true,
        shared: false,
      }),
    ]);
    expect(c.builds).toEqual([
      expect.objectContaining({
        estimateUsd: 0.56,
        actualUsd: null,
        costUsd: 0.56,
        isEstimate: true,
        receiptUrl: "https://td.example/r/1",
      }),
    ]);
    expect(c.totalUsd).toBeCloseTo(1.3625);
    expect(c.totalIsEstimate).toBe(true);
  });

  it("复刻片：模板的复刻会话列出来、标共用，不计入这一条的合计；有实际金额的出片不标估", async () => {
    const b = await bootOutputs();
    const r = b.production({ kind: "replica", name: null, runPath: "reference.svrun" });
    b.job("template", b.template.id, 1.17);
    b.build(r, { estimate: 0.5, actual: 0.45 });
    const c = b.costs.outputCosts(r);
    expect(c.agent).toEqual([expect.objectContaining({ costUsd: 1.17, shared: true })]);
    expect(c.builds[0]).toMatchObject({ costUsd: 0.45, isEstimate: false });
    expect(c.totalUsd).toBeCloseTo(0.45);
    expect(c.totalIsEstimate).toBe(false);
  });

  it("没有任何花费：两张表都空、合计 0；不存在的 404", async () => {
    const b = await bootOutputs();
    const id = b.production({ status: "awaiting_cost_confirm" });
    expect(b.costs.outputCosts(id)).toMatchObject({ agent: [], builds: [], totalUsd: 0, totalIsEstimate: false });
    expect(() => b.costs.outputCosts("nope")).toThrow(expect.objectContaining({ status: 404 }));
  });
});
