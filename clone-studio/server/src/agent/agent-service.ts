import { setAgentStopper } from "../services/agent-stopper.js";
import { requireTemplate } from "../services/archive.js";
import { sseHub } from "../lib/sse.js";
import { resetAgentProducts } from "../hypit/workspace.js";
import { settingsFromDb } from "./agent-settings.js";
import type { AgentJobRow } from "./job-store.js";
import { appendIntercept, appendMessage } from "./message-store.js";
import { runAgent } from "./runner.js";
import { Scheduler, type SchedulerDeps } from "./scheduler.js";

/**
 * 把调度器接进应用（Spec REQ-003）：消息落库 + 推 SSE，工作目录按 owner 现查，
 * 重跑清 Agent 产物。这里是 Agent 这一块唯一的对外入口，路由与删除流程都走它。
 *
 * 单例：队列和在跑的会话都在内存里，全进程只能有一份（多一份就会超并发上限）。
 */
let instance: Scheduler | undefined;

export interface AgentServiceOptions {
  /** 生产传 app.log；测试可换掉 run / settings 之类 */
  overrides?: Partial<SchedulerDeps>;
}

export function agentScheduler(options: AgentServiceOptions = {}): Scheduler {
  if (instance && options.overrides) {
    throw new Error("调度器已经建好了：overrides 只在第一次调用时生效，晚传等于没传");
  }
  instance ??= new Scheduler({
    run: runAgent,
    settings: settingsFromDb,
    workspaceOf: (job) => workspaceOf(job),
    resetWorkspace: (job) => resetAgentProducts(workspaceOf(job)),
    onMessage: (jobId, message) => {
      const stored = appendMessage(jobId, message);
      announce(jobId, stored);
    },
    onIntercept: (jobId, denial) => {
      const stored = appendIntercept(jobId, denial);
      announce(jobId, stored);
    },
    onChange: (job) => {
      const view = present(job);
      notify(`job:${job.id}`, "agent-job", view);
      // 模板页不知道 job id：状态变化也往对象的主题推一份
      notify(`${job.owner_kind}:${job.owner_id}`, "agent-job", view);
    },
    ...options.overrides,
  });
  return instance;
}

/**
 * 推的是「第几条」而不是消息本身：抽屉按 seq 去拉，刷新、断线重连、正常流式三条路
 * 收敛到同一个来源（AC-009）。这类事件不进 SSE 的重放缓冲——它本来就能按 seq 补回来，
 * 占着缓冲反而会把别的主题的事件挤掉。
 */
function announce(jobId: string, stored: { seq: number; type: string }): void {
  notify(`job:${jobId}`, "agent-message", { jobId, seq: stored.seq, type: stored.type }, { buffer: false });
}

/**
 * 推送失败不能把一次会话判失败：这些回调跑在 runner 的 onMessage 里，往上抛会被记成
 * 「消息落库失败」，于是浏览器那边断一下就赔掉一次付费运行。落库失败才该让任务失败。
 */
function notify(topic: string, event: string, data: unknown, options?: { buffer?: boolean }): void {
  try {
    sseHub.publish(topic, event, data, options);
  } catch {
    // 推不出去就算了：真相在库里，前端下次拉就补上
  }
}

/**
 * 启动时接上删除流程：删对象前先停它上面的 Agent 任务（AC-002）。
 * 放在这里而不是让 deletion 直接 import，是为了不把 Agent SDK 拉进删除流程的依赖图。
 */
export function registerAgentStopper(): void {
  setAgentStopper(async (owners) => {
    // 并发停：串着停的话，删一个客户下的 10 个模板最坏要等 10 × 停止超时
    const counts = await Promise.all(owners.map((owner) => agentScheduler().stopOwner(owner.kind, owner.id)));
    return counts.reduce((sum, n) => sum + n, 0);
  });
}

/** 测试用：换一份新的调度器（生产里一个进程只建一次） */
export function resetAgentScheduler(): void {
  instance = undefined;
  setAgentStopper(undefined);
}

/**
 * 任务的工作目录。模板就是它自己的工程目录；变体（production）的目录在 Phase 8 定，
 * 现在明确报错，不猜一个路径出来——猜错会把 Agent 放进别人的目录里写。
 */
export function workspaceOf(job: Pick<AgentJobRow, "owner_kind" | "owner_id">): string {
  if (job.owner_kind !== "template") {
    throw new Error(`变体任务的工作目录要等 Phase 8 定：${job.owner_kind}/${job.owner_id}`);
  }
  const template = requireTemplate(job.owner_id);
  // 以库里记的路径为准，和上传、播放那几处同一个来源：目录迁移过之后按 id 拼出来的是旧路径
  if (!template.workspace_path) throw new Error(`模板还没有工作目录：${template.id}`);
  return template.workspace_path;
}

/** 给界面的任务形状。前端直接按它写类型，别各自再抄一份 */
export interface AgentJobView {
  id: string;
  ownerKind: AgentJobRow["owner_kind"];
  ownerId: string;
  status: AgentJobRow["status"];
  sessionId: string | null;
  /** 任务第一次开始的时间 */
  startedAt: string | null;
  /**
   * 本次运行**当前这一段**的起点，只在 status 为 running 时有意义。
   * 「用时」用一条公式算，所有状态都成立：
   * `runElapsedMs + (status === "running" ? now - runStartedAt : 0)`。
   * 等额度、排队时它自然冻住，既不会虚高，也不会出现负数。
   */
  runStartedAt: string | null;
  /** 本次运行在此之前已经跑掉的毫秒数；继续 / 重跑是新的一次运行，从 0 起算 */
  runElapsedMs: number;
  endedAt: string | null;
  costUsd: number;
  costIsEstimate: boolean;
  stopReason: string | null;
  modelId: string | null;
  resumeAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/** 库里的列名是 snake_case，界面统一用 camelCase；任务提示不给界面（它可能很长） */
export function present(job: AgentJobRow): AgentJobView {
  return {
    id: job.id,
    ownerKind: job.owner_kind,
    ownerId: job.owner_id,
    status: job.status,
    sessionId: job.session_id,
    startedAt: job.started_at,
    runStartedAt: job.run_started_at,
    runElapsedMs: job.run_elapsed_ms,
    endedAt: job.ended_at,
    costUsd: job.cost_usd,
    costIsEstimate: job.cost_is_estimate === 1,
    stopReason: job.stop_reason,
    modelId: job.model_id,
    resumeAt: job.resume_at,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}
