import { describe, expect, it } from "vitest";
import { describeNextActions, describeStop, isEnded, nextActions, statusMarkOf } from "./agent-status.js";
import { agentJob } from "../test/agent-fixtures.js";

describe("describeStop：stop_reason 翻成人话", () => {
  it.each([
    ["user_abort", "已手动中止"],
    ["user_cancel", "任务已取消"],
    ["backend_restart", "后端重启，运行被打断"],
    ["delete_aborted", "删除对象时停下了运行"],
    ["timeout：运行超过 45 分钟", "超时：运行超过 45 分钟"],
    ["budget：花费达到上限", "超预算：花费达到上限"],
    ["idle：10 分钟没有任何新消息", "卡死：10 分钟没有任何新消息"],
    ["repeated_failure：同一条命令连续失败 5 次：ls", "卡死：同一条命令连续失败 5 次：ls"],
    ["error_during_execution：boom", "error_during_execution：boom"],
  ])("%s → %s", (raw, text) => {
    expect(describeStop({ status: "tripped", stopReason: raw })).toBe(text);
  });

  it("完成且没有原因：说「任务完成」；其余没有原因给空", () => {
    expect(describeStop({ status: "done", stopReason: null })).toBe("任务完成");
    expect(describeStop({ status: "failed", stopReason: null })).toBe("");
  });
});

describe("结束后还能做什么", () => {
  it("已取消只给重跑；熔断 / 中断 / 失败可继续可重跑；完成与未结束的什么都不给；永远没有「取消任务」", () => {
    expect(nextActions("cancelled")).toEqual(["rerun"]);
    for (const s of ["tripped", "interrupted", "failed"] as const)
      expect(nextActions(s)).toEqual(["continue", "rerun"]);
    for (const s of ["done", "running", "queued", "awaiting_quota"] as const) expect(nextActions(s)).toEqual([]);
    expect(describeNextActions("cancelled")).toBe("没有会话可继续，只能重跑");
    expect(describeNextActions("done")).toBeNull();
  });

  it("isEnded：只有终态出结束卡", () => {
    expect(isEnded(agentJob({ status: "done" }))).toBe(true);
    expect(isEnded(agentJob({ status: "cancelled" }))).toBe(true);
    expect(isEnded(agentJob({ status: "running" }))).toBe(false);
    expect(isEnded(agentJob({ status: "awaiting_quota" }))).toBe(false);
  });

  it("状态标记：running 在抽屉里叫「运行中」，其余沿用 CMP-003", () => {
    expect(statusMarkOf("running")).toEqual({ kind: "agent_running", label: "运行中" });
    expect(statusMarkOf("tripped")).toEqual({ kind: "tripped" });
  });
});
