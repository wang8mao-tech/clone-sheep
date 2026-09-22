import { db } from "../db/index.js";

/** Agent 的熔断与并发设置（设置页 REQ-008） */
export interface AgentSettings {
  timeoutMinutes: number;
  budgetUsd: number;
  concurrency: number;
}

/** 设置页的 Agent 熔断与并发（REQ-008），每次调度现读，改了设置下一个任务就生效 */
export function settingsFromDb(): AgentSettings {
  const row = db()
    .prepare("SELECT agent_timeout_minutes, agent_budget_usd, agent_concurrency FROM settings WHERE id = 1")
    .get() as { agent_timeout_minutes: number; agent_budget_usd: number; agent_concurrency: number } | undefined;
  return {
    timeoutMinutes: row?.agent_timeout_minutes ?? 45,
    budgetUsd: row?.agent_budget_usd ?? 5,
    concurrency: row?.agent_concurrency ?? 2,
  };
}
