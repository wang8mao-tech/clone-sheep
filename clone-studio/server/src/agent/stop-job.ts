import type { Clock } from "./breaker.js";
import { ACTIVE_STATUSES, requireJob, updateJob, type AgentJobRow } from "./job-store.js";
import { SchedulerError, type Pending, type Running } from "./scheduler-types.js";

/**
 * 停一个任务（Spec REQ-003）：取消 → 已取消，中止 → 中断（跑过的才有得继续）。
 * 运行中的要等会话真的结束再返回——AC-002 的原话是「Agent 进程已结束再删目录」。
 */

/** 等一次运行停下来的上限：runner 的宽限（10 秒）加上进程收尾的余量 */
export const STOP_TIMEOUT_MS = 30_000;

export interface StopContext {
  running: Map<string, Running>;
  queue: Pending[];
  waiting: Map<string, unknown>;
  clock: Clock;
  patch(jobId: string, patch: Parameters<typeof updateJob>[1]): AgentJobRow;
  pump(): void;
}

export async function stopJob(ctx: StopContext, jobId: string, action: "cancel" | "abort"): Promise<AgentJobRow> {
  const job = requireJob(jobId);
  const running = ctx.running.get(jobId);
  if (running) return stopRunning(ctx, jobId, action, running);

  if (!ACTIVE_STATUSES.includes(job.status)) throw new SchedulerError("NOT_ACTIVE", "任务已经结束了");
  const queued = ctx.queue.findIndex((p) => p.jobId === jobId);
  if (queued >= 0) ctx.queue.splice(queued, 1);
  ctx.clock.clearTimeout(ctx.waiting.get(jobId));
  ctx.waiting.delete(jobId);
  // 跑过的（有会话、或正等额度）中止成「中断」，可以继续；从没跑起来过的中止等于取消
  const interrupted = action === "abort" && (job.status === "awaiting_quota" || job.session_id !== null);
  return ctx.patch(jobId, {
    status: interrupted ? "interrupted" : "cancelled",
    stop_reason: interrupted ? "user_abort" : "user_cancel",
    ended_at: new Date().toISOString(),
    resume_at: null,
  });
}

async function stopRunning(
  ctx: StopContext,
  jobId: string,
  action: "cancel" | "abort",
  running: Running,
): Promise<AgentJobRow> {
  running.action ??= action;
  running.controller.abort();
  // 有上限：runner 自己会在宽限到点后硬停，真卡住也不能把删除对话框永远挂在那
  const timedOut = Symbol("timeout");
  const raced = await Promise.race([
    running.done,
    new Promise((resolve) => ctx.clock.setTimeout(() => resolve(timedOut), STOP_TIMEOUT_MS)),
  ]);
  if (raced !== timedOut) return requireJob(jobId);

  // 放掉名额并把任务标失败：会话那边 runner 已经硬停过了，留着只会让这个对象谁也跑不了
  ctx.running.delete(jobId);
  ctx.patch(jobId, {
    status: "failed",
    stop_reason: "停止超时：会话没能在预期时间内结束",
    ended_at: new Date().toISOString(),
  });
  ctx.pump();
  throw new SchedulerError("STOP_TIMEOUT", "Agent 会话没能在预期时间内停下，任务已标为失败", 504);
}
