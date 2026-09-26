import type { StatusKind } from "../components/ui/StatusMark.js";
import type { AgentJobStatus, AgentJobView } from "./agent.js";

/** 任务状态 → CMP-003 状态标记。running 在抽屉里就叫「运行中」，不套变体页的「Agent 写稿中」 */
export function statusMarkOf(status: AgentJobStatus): { kind: StatusKind; label?: string } {
  if (status === "running") return { kind: "agent_running", label: "运行中" };
  return { kind: status };
}

/** 结束卡的标题 */
export const END_TITLE: Record<Exclude<AgentJobStatus, "queued" | "running" | "awaiting_quota">, string> = {
  done: "完成",
  tripped: "已熔断",
  interrupted: "中断",
  cancelled: "已取消",
  failed: "失败",
};

export type EndedJob = AgentJobView & { status: keyof typeof END_TITLE };

/** 已经结束（结束卡要出现）：完成、熔断、中断、取消、失败 */
export function isEnded(job: AgentJobView): job is EndedJob {
  return job.status in END_TITLE;
}

/** 熔断原因的代码（server/src/agent/breaker.ts TripReason，落库为「代码：说明」） */
const TRIP_LABEL: Record<string, string> = {
  timeout: "超时",
  budget: "超预算",
  idle: "卡死",
  repeated_failure: "卡死",
};

/** stop_reason 翻成人话；认不出的原样给，不改写上游原文（Design-Brief 6.2） */
export function describeStop(job: Pick<AgentJobView, "status" | "stopReason">): string {
  const raw = job.stopReason;
  if (!raw) return job.status === "done" ? "任务完成" : "";
  if (raw === "user_abort") return "已手动中止";
  if (raw === "user_cancel") return "任务已取消";
  if (raw === "backend_restart") return "后端重启，运行被打断";
  if (raw === "delete_aborted") return "删除对象时停下了运行";
  const sep = raw.indexOf("：");
  const code = sep > 0 ? raw.slice(0, sep) : raw;
  const label = TRIP_LABEL[code];
  if (label) return sep > 0 ? `${label}：${raw.slice(sep + 1)}` : label;
  return raw;
}

/**
 * 结束之后还能做什么（按钮在工作区 CMP-009，Task 5.5；抽屉只说明，Design-Brief §A.3）。
 * 与 server/src/agent/job-store.ts 的 CONTINUABLE / RERUNNABLE 一致：已取消的没有会话可 resume，
 * 只能重跑；完成的不许重跑（会清掉可能已验货通过的稿子）。没有「取消任务」这一项。
 */
export function nextActions(status: AgentJobStatus): Array<"continue" | "rerun"> {
  if (status === "tripped" || status === "interrupted" || status === "failed") return ["continue", "rerun"];
  if (status === "cancelled") return ["rerun"];
  return [];
}

/** 出片单位上还允许的动作（任务本身能做、且这条变体此刻允许）；模板的任务没有 gate，照任务本身 */
export type ActionGate = { continue: boolean; rerun: boolean } | null;

export function allowedActions(status: AgentJobStatus, gate: ActionGate): Array<"continue" | "rerun"> {
  return nextActions(status).filter((a) => !gate || gate[a]);
}

export function describeNextActions(status: AgentJobStatus, gate: ActionGate = null): string | null {
  const actions = allowedActions(status, gate);
  if (actions.length === 2) return "可以继续（接着同一会话）或重跑";
  if (actions[0] === "rerun") return nextActions(status).length === 2 ? "可以重跑" : "没有会话可继续，只能重跑";
  if (actions[0] === "continue") return "可以继续（接着同一会话）";
  return null;
}
