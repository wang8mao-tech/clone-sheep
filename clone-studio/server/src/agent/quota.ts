import type { AgentJobRow } from "./job-store.js";
import { continuePrompt } from "./prompts.js";
import type { Pending } from "./scheduler-types.js";

/**
 * 订阅限流之后怎么办（Spec REQ-003「订阅限流不算失败：进等待额度，到重置时间自动 resume」）。
 * 纯算：等待额度这次运行还剩多少墙钟与花费，够不够再跑一段。调度器拿结果去改库、挂定时器。
 */
export type QuotaPlan = { kind: "trip"; reason: string } | { kind: "wait"; next: Pending };

export interface Spend {
  cost: number;
  costBefore: number;
  elapsedMs: number;
}

export function planQuotaResume(job: AgentJobRow, pending: Pending, spend: Spend, runStartedAt?: string): QuotaPlan {
  // maxBudgetUsd 只算本次 query() 起的花费，所以续跑要传剩余额度；等额度的时间不算运行时间
  const budgetUsd = pending.budgetUsd - Math.max(0, spend.cost - spend.costBefore);
  const wallMs = pending.wallMs - spend.elapsedMs;
  if (budgetUsd <= 0) return { kind: "trip", reason: "budget：花费达到上限" };
  if (wallMs <= 0) return { kind: "trip", reason: "timeout：运行时间用完" };

  // 会话还没起来就被限流的，没有可 resume 的会话：原样重发任务
  const resume = job.session_id ?? pending.resume;
  // 续跑是同一次运行：把起点带过去（复审 S1-M3）
  const rest = {
    jobId: job.id,
    budgetUsd,
    wallMs,
    totalWallMs: pending.totalWallMs,
    ...(runStartedAt ? { runStartedAt } : {}),
  };
  return {
    kind: "wait",
    next: resume ? { ...rest, prompt: continuePrompt(), resume } : { ...rest, prompt: pending.prompt },
  };
}
