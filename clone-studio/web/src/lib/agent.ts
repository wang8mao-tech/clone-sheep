import { api } from "./api.js";

/**
 * Agent 任务（Spec REQ-003）的前端数据形状。逐字段对着
 * server/src/agent/agent-service.ts 的 AgentJobView 与 message-store.ts 的 MessagePage。
 */

export type AgentJobStatus =
  "queued" | "running" | "awaiting_quota" | "tripped" | "interrupted" | "done" | "failed" | "cancelled";

export interface AgentJobView {
  id: string;
  ownerKind: "template" | "production";
  ownerId: string;
  status: AgentJobStatus;
  sessionId: string | null;
  startedAt: string | null;
  /** 本次运行当前这一段的起点，只在 running 时有意义 */
  runStartedAt: string | null;
  /** 本次运行在此之前已经跑掉的毫秒数 */
  runElapsedMs: number;
  endedAt: string | null;
  costUsd: number;
  costIsEstimate: boolean;
  stopReason: string | null;
  profileName: string | null;
  modelId: string | null;
  resumeAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface AgentMessageView {
  seq: number;
  role: string | null;
  type: string;
  /** 原始消息（SDK 消息或宿主拦截记录），不截断 */
  payload: unknown;
  createdAt: string;
}

export interface MessagePage {
  messages: AgentMessageView[];
  hasOlder: boolean;
  hasNewer: boolean;
  firstSeq: number;
  lastSeq: number;
  /** 往后拉的唯一游标；往前翻的页恒为 0，不能拿来推游标 */
  nextSeq: number;
  /** 库里最后一条的 seq：只用来判断追平没有，不是游标 */
  jobLastSeq: number;
}

export interface TemplateJobSnapshot extends MessagePage {
  job: AgentJobView | null;
}

export interface JobHead {
  job: AgentJobView;
  jobLastSeq: number;
}

/** 还没结束的状态：顶栏给「中止」、用时往前走的只有其中的 running */
export const ACTIVE_STATUSES: readonly AgentJobStatus[] = ["queued", "running", "awaiting_quota"];

export function isActive(status: AgentJobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** 中止要等会话停下来：interrupt 最多 10 秒没回就硬停，再加收尸，给足余量 */
const ABORT_TIMEOUT_MS = 30_000;

/** 重跑要先清掉工作目录里的 Agent 产物再排队，给足余量 */
const RERUN_TIMEOUT_MS = 30_000;

export const agentApi = {
  templateJob: (templateId: string) => api.get<TemplateJobSnapshot>(`/api/templates/${templateId}/agent-job`),
  job: (jobId: string) => api.get<JobHead>(`/api/agent-jobs/${jobId}`),
  after: (jobId: string, afterSeq: number) =>
    api.get<MessagePage>(`/api/agent-jobs/${jobId}/messages?afterSeq=${afterSeq}`),
  before: (jobId: string, beforeSeq: number) =>
    api.get<MessagePage>(`/api/agent-jobs/${jobId}/messages?beforeSeq=${beforeSeq}`),
  /** 继续：resume 同一会话（熔断 / 中断 / 失败之后） */
  continue: (jobId: string) => api.post<{ job: AgentJobView }>(`/api/agent-jobs/${jobId}/continue`),
  /** 重跑：清掉 Agent 产物、按原任务提示开一个新任务；清目录可能要一会儿 */
  rerun: (jobId: string) =>
    api.post<{ job: AgentJobView }>(`/api/agent-jobs/${jobId}/rerun`, undefined, RERUN_TIMEOUT_MS),
  abort: (jobId: string) =>
    api.post<{ job: AgentJobView }>(`/api/agent-jobs/${jobId}/abort`, undefined, ABORT_TIMEOUT_MS),
};

export type AgentApi = typeof agentApi;
