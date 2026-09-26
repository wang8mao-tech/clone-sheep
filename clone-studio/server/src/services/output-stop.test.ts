import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bootOutputs, useOutputsSandbox, type BootedOutputs } from "./outputs-test-kit.js";

/**
 * 成片卡片的停因（REQ-007、Design-Brief §6.2「先说哪一步失败，再给原文」）：顺序同 ④ 的 stopReason。
 * 9.2 第四轮审查 S1-H1 / S1-M1：估价没过的不能被说成 Agent 停下；重试后估价没过不能显示旧的出片错误
 */

useOutputsSandbox();

function blockedEstimate(b: BootedOutputs, productionId: string, reason: string, createdAt: string): void {
  b.d
    .prepare(
      `INSERT INTO estimates (id, production_id, kind, total_usd, lines_json, reason, decision, reasons_json, created_at)
     VALUES (?, ?, 'blocked', NULL, '[]', ?, 'blocked', '[]', ?)`,
    )
    .run(randomUUID(), productionId, reason, createdAt);
}

function job(b: BootedOutputs, ownerId: string, status: string, stopReason: string | null): void {
  b.d
    .prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, stop_reason, created_at) VALUES (?, 'production', ?, ?, ?, ?)`,
    )
    .run(randomUUID(), ownerId, status, stopReason, "2026-09-25T09:00:00.000Z");
}

const stopOf = (b: BootedOutputs, id: string) => b.outputs.listOutputs(b.template.id).find((o) => o.id === id)?.stop;

describe("stop：停在哪一步", () => {
  it("估价没过、没出过片（复刻片）：估价这一步，原文是没过的原因；不说 Agent", async () => {
    const b = await bootOutputs();
    const r = b.production({ kind: "replica", name: null, status: "failed", runPath: "reference.svrun" });
    blockedEstimate(b, r, "有请求没有可用的 Provider", "2026-09-25T09:00:00.000Z");
    expect(stopOf(b, r)).toEqual({ step: "estimate", text: "估价没过，不出片\n有请求没有可用的 Provider" });
  });

  it("出片失败后重试、重新估价没过（估价比出片新）：说估价，不说旧的出片错误；仍能重试", async () => {
    const b = await bootOutputs();
    const v = b.production({ status: "failed" });
    b.build(v, { status: "failed", file: null });
    b.d
      .prepare("UPDATE builds SET error_code = 'BUILD_FAILED', error_message = '旧的渲染错误' WHERE production_id = ?")
      .run(v);
    blockedEstimate(b, v, "preflight 没有通过", "2099-01-01T00:00:00.000Z");
    const card = b.outputs.listOutputs(b.template.id).find((o) => o.id === v);
    expect(card?.stop).toEqual({ step: "estimate", text: "估价没过，不出片\npreflight 没有通过" });
    expect(card?.retryable).toBe(true);
  });

  it("出片失败（估价是更早的）：出片这一步，code 与原文", async () => {
    const b = await bootOutputs();
    const v = b.production({ status: "failed" });
    blockedEstimate(b, v, "早先没过", "2000-01-01T00:00:00.000Z");
    b.build(v, { status: "failed", file: null });
    b.d
      .prepare("UPDATE builds SET error_code = 'BUILD_FAILED', error_message = '渲染炸了' WHERE production_id = ?")
      .run(v);
    expect(stopOf(b, v)).toEqual({ step: "build", text: "出片失败 · BUILD_FAILED\n渲染炸了" });
  });

  it("变体熔断 / 重跑后 Agent 又失败：Agent 这一步，带任务的停因", async () => {
    const b = await bootOutputs();
    const t = b.production({ status: "tripped" });
    b.build(t, { status: "failed", file: null });
    // 生产里写的是「原因码：细节」（agent/outcome.ts）：原样给出去，界面按 ④ 的 describeStop 翻译
    job(b, t, "tripped", "budget：花费达到上限");
    expect(stopOf(b, t)).toEqual({ step: "agent", text: "Agent 写稿停下", reason: "budget：花费达到上限" });
    const rerun = b.production({ status: "failed", runPath: null });
    b.build(rerun, { status: "failed", file: null });
    expect(stopOf(b, rerun)).toEqual({ step: "agent", text: "Agent 写稿停下", reason: null });
  });

  it("完成的、在流水线里的：没有停因", async () => {
    const b = await bootOutputs();
    const done = b.production();
    b.build(done);
    const pending = b.production({ status: "awaiting_cost_confirm" });
    expect(stopOf(b, done)).toBeNull();
    expect(stopOf(b, pending)).toBeNull();
    // 复刻片没有 Agent 这一段可指（会话挂在模板上）：说不清就不说，不冒充「Agent 写稿停下」
    const replica = b.production({ kind: "replica", name: null, status: "failed", runPath: "reference.svrun" });
    expect(stopOf(b, replica)).toBeNull();
  });
});
