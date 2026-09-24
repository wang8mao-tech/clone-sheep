import {
  activeJobsOf,
  CONTINUABLE_STATUSES,
  latestJobOf,
  RERUNNABLE_STATUSES,
  type AgentJobRow,
  type OwnerKind,
} from "./job-store.js";
import { SchedulerError } from "./scheduler-types.js";

/** 继续 / 重跑 / 新建之前的前置检查（Spec REQ-003）：只读库，不碰调度器自己的状态 */

export function assertOwnerFree(ownerKind: OwnerKind, ownerId: string): void {
  if (activeJobsOf(ownerKind, ownerId).length > 0) {
    throw new SchedulerError("JOB_ACTIVE", "这个对象已有未结束的 Agent 任务，先等它结束或中止");
  }
}

export function assertLatest(job: AgentJobRow): void {
  if (latestJobOf(job.owner_kind, job.owner_id)?.id !== job.id) {
    throw new SchedulerError("SUPERSEDED", "这个任务已被重跑取代，只能操作最新的任务");
  }
}

/** 能继续的：会话还在（或还能原样重发），状态是熔断 / 中断 / 失败 */
export function assertContinuable(job: AgentJobRow): void {
  if (!CONTINUABLE_STATUSES.includes(job.status)) {
    throw new SchedulerError("NOT_CONTINUABLE", "只有已熔断、中断或失败的任务可以继续");
  }
}

/** 能打回的：会话做完了（验货打回只对「完成」的那次说），而且会话还在——意见要 resume 进原会话 */
export function assertReworkable(job: AgentJobRow): asserts job is AgentJobRow & { session_id: string } {
  if (job.status !== "done") throw new SchedulerError("NOT_REWORKABLE", "只有已完成的任务可以打回");
  if (!job.session_id) throw new SchedulerError("NO_SESSION", "这个任务的会话没起来，接不上打回意见");
}

/** 能重跑的：已经结束了，而且留着任务提示原文。完成的不许——那会清掉一份可能已验货通过的稿子 */
export function assertRerunnable(job: AgentJobRow): asserts job is AgentJobRow & { prompt: string } {
  if (!RERUNNABLE_STATUSES.includes(job.status)) {
    throw new SchedulerError("NOT_RERUNNABLE", "只有已熔断、中断、失败或已取消的任务可以重跑");
  }
  if (!job.prompt) throw new SchedulerError("NO_PROMPT", "这个任务没有保存任务提示，无法重跑");
}
