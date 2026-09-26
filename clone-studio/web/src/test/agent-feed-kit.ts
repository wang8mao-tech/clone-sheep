import type { AgentJobView } from "../lib/agent.js";

/** AgentFeed 单测共用：任务视图工厂 */
export const TPL = "tpl-1";

export function job(id = "job-1", over: Partial<AgentJobView> = {}): AgentJobView {
  return {
    id,
    ownerKind: "template",
    ownerId: TPL,
    status: "running",
    sessionId: "s",
    startedAt: "2026-09-23T10:00:00.000Z",
    runStartedAt: "2026-09-23T10:00:00.000Z",
    runElapsedMs: 0,
    endedAt: null,
    costUsd: 0,
    costIsEstimate: true,
    stopReason: null,
    profileName: null,
    modelId: null,
    resumeAt: null,
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: null,
    ...over,
  };
}
