import { requireJob } from "./job-store.js";
import { planQuotaResume, type Spend } from "./quota.js";
import type { Pending } from "./scheduler-types.js";
import type { StopContext } from "./stop-job.js";

/**
 * 订阅限流：进「等待额度」，到点用剩下的墙钟与花费自动续跑（算法在 quota.ts）。
 * 从调度器里拆出来（Task 10.2 把 scheduler.ts 撑过了 300 行），和 stop-job.ts 一样拿调度器的上下文干活
 */
export function awaitQuota(
  ctx: Omit<StopContext, "running">,
  onRunStop: (jobId: string, run: { reason: string }) => void,
  pending: Pending,
  resumeAt: Date,
  spend: Spend,
): void {
  const job = requireJob(pending.jobId);
  const plan = planQuotaResume(job, pending, spend);
  // 额度用光就不会续跑了：停下记录写真正的原因，别让抽屉说「等恢复后续跑」（复审 S1-R3-2）
  onRunStop(job.id, { reason: plan.kind === "trip" ? plan.reason : "awaiting_quota" });
  if (plan.kind === "trip") {
    // 这里也是终态：额度用光不再续跑，这一段跑掉的时间同样要落库。少写这一笔，
    // 界面就会出现「原因：运行时间用完 / 用时 0 秒」这种自相矛盾的行（复审 S1-M1(r7)）
    const ended = { cost_usd: spend.cost, ended_at: new Date().toISOString() };
    const elapsed = pending.elapsedMs ?? job.run_elapsed_ms;
    ctx.patch(job.id, { status: "tripped", stop_reason: plan.reason, run_elapsed_ms: elapsed, ...ended });
    return;
  }
  const next = plan.next;
  // 等额度期间「用时」冻在已经跑掉的那些：累计值上一步已经并好，这里落库即可。
  // 不动 run_started_at——它只在运行中有意义，往前挪会虚高、往后挪会变成未来时间（复审 S1-M1(r6)）
  ctx.patch(job.id, {
    status: "awaiting_quota",
    cost_usd: spend.cost,
    run_elapsed_ms: next.elapsedMs ?? 0,
    resume_at: resumeAt.toISOString(),
  });
  const timer = ctx.clock.setTimeout(
    () => {
      ctx.waiting.delete(job.id);
      ctx.patch(job.id, { status: "queued", resume_at: null });
      ctx.queue.push(next);
      ctx.pump();
    },
    Math.max(0, resumeAt.getTime() - ctx.clock.now()),
  );
  ctx.waiting.set(job.id, timer);
}
