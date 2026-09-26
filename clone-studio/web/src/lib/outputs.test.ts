import { describe, expect, it } from "vitest";
import { output } from "../test/outputs-kit.js";
import {
  deleteBlocked,
  formatClipSeconds,
  matchesOutput,
  nextStepHint,
  retryable,
  shouldPoll,
  stopText,
} from "./outputs.js";

/** ⑤ 成片的纯规则：轮询、筛选、能不能重试 / 删除、时长格式 */

describe("shouldPoll", () => {
  it("有渲染中或在流水线里的才轮询；都结束了（含失败、熔断归失败）就停", () => {
    expect(shouldPoll([output(1), output(2, { status: "building" })])).toBe(true);
    expect(shouldPoll([output(1, { status: "pending" })])).toBe(true);
    expect(shouldPoll([output(1), output(2, { status: "failed", productionStatus: "tripped" })])).toBe(false);
    expect(shouldPoll([])).toBe(false);
    // 等人（素材待审、待确认）不轮询：状态变化有事件推过来
    expect(shouldPoll([output(1, { status: "pending", productionStatus: "asset_review" })])).toBe(false);
    expect(shouldPoll([output(1, { status: "pending", productionStatus: "awaiting_cost_confirm" })])).toBe(false);
  });
});

describe("matchesOutput", () => {
  it("进行中 = 渲染中 + 流水线里；失败 = 失败 / 中断 / 已取消", () => {
    expect(matchesOutput(output(1, { status: "pending" }), "running")).toBe(true);
    expect(matchesOutput(output(1, { status: "interrupted" }), "failed")).toBe(true);
    expect(matchesOutput(output(1, { status: "done" }), "failed")).toBe(false);
  });
});

describe("retryable / agentStopped / deleteBlocked", () => {
  it("能不能重试出片听服务端的（同 build/retry 的判断，含重跑后运行文件已清掉）", () => {
    expect(retryable(output(1, { status: "failed", retryable: true }))).toBe(true);
    expect(retryable(output(1, { status: "failed", retryable: false }))).toBe(false);
  });

  it("下一步去哪儿：估价没过 → 变体去 ④、复刻片去 ②；Agent 停下 → ④；能重试出片的不另指路（9.2 第四轮审查 S1-H1）", () => {
    const estimate = { step: "estimate" as const, text: "估价没过，不出片" };
    expect(nextStepHint(output(1, { status: "failed", stop: estimate }))).toMatch(/④/);
    expect(nextStepHint(output(1, { kind: "replica", status: "failed", stop: estimate }))).toBe(
      "去 ② 复刻页重新估价。",
    );
    expect(nextStepHint(output(1, { status: "failed", stop: { step: "agent", text: "Agent 写稿停下" } }))).toMatch(
      /④ 变体队列/,
    );
    expect(nextStepHint(output(1, { status: "failed", retryable: true, stop: estimate }))).toBeNull();
    expect(nextStepHint(output(1))).toBeNull();
  });

  it("完成的、失败的变体能删；失败的复刻片、流水线里的不能删", () => {
    expect(deleteBlocked(output(1))).toBeNull();
    expect(deleteBlocked(output(1, { status: "failed" }))).toBeNull();
    expect(deleteBlocked(output(1, { kind: "replica", status: "interrupted" }))).toMatch(/复刻片/);
    expect(deleteBlocked(output(1, { status: "building" }))).toMatch(/流水线/);
  });
});

describe("formatClipSeconds", () => {
  it("m:ss，秒数补零；取不到给「—」", () => {
    expect(formatClipSeconds(9)).toBe("0:09");
    expect(formatClipSeconds(125.6)).toBe("2:06");
    expect(formatClipSeconds(null)).toBe("—");
  });
});

describe("stopText", () => {
  it("Agent 停因用 ④ 同一个 describeStop 翻成人话（生产格式「原因码：细节」）；别的步骤原样（9.2 第五轮审查 S1-M3）", () => {
    expect(stopText({ step: "agent", text: "Agent 写稿停下", reason: "budget：花费达到上限" })).toBe(
      "Agent 写稿停下：超预算：花费达到上限",
    );
    expect(stopText({ step: "agent", text: "Agent 写稿停下", reason: "user_abort" })).toBe(
      "Agent 写稿停下：已手动中止",
    );
    expect(stopText({ step: "agent", text: "Agent 写稿停下", reason: null })).toBe("Agent 写稿停下");
    expect(stopText({ step: "build", text: "出片失败 · X" })).toBe("出片失败 · X");
  });
});
