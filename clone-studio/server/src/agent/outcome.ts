import type { Verdict } from "./breaker.js";
import type { JobStatus } from "./job-store.js";
import type { RunOutcome } from "./runner.js";

/**
 * 一次运行怎么结束的 → 任务该进哪个状态（Spec REQ-003）。纯函数，调度器照它改库。
 *
 * 先看人（取消 / 中止），再看熔断器（限流 / 熔断），最后看会话本身的结果。顺序有讲究：
 * 人点了中止、会话随之以 aborted 收尾，不能被当成「会话出错」；熔断器掐掉的会话同理。
 */
export type Settlement =
  { kind: "quota"; resumeAt: Date } | { kind: "end"; status: JobStatus; stopReason: string | null };

export function settle(
  outcome: RunOutcome,
  verdict: Verdict | undefined,
  action: "cancel" | "abort" | undefined,
): Settlement {
  if (action === "cancel") return { kind: "end", status: "cancelled", stopReason: "user_cancel" };
  if (action === "abort") return { kind: "end", status: "interrupted", stopReason: "user_abort" };
  if (verdict?.kind === "quota") return { kind: "quota", resumeAt: verdict.resumeAt };
  if (verdict?.kind === "trip") {
    return { kind: "end", status: "tripped", stopReason: `${verdict.reason}：${verdict.detail}` };
  }
  // 最后一条消息没存进去：结果再好也不能当完成，否则抽屉里看到的和实际不一致
  if (outcome.callbackError) {
    return { kind: "end", status: "failed", stopReason: `消息落库失败：${outcome.callbackError}` };
  }
  const result = outcome.result;
  if (result?.subtype === "success") return { kind: "end", status: "done", stopReason: null };
  const detail = result ? [result.subtype, ...result.errors].join("：") : "";
  return { kind: "end", status: "failed", stopReason: outcome.error ?? (detail || "会话没有返回结果") };
}
