import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSettings } from "./agent-settings.js";
import type { Clock } from "./breaker.js";
import type { Denial } from "./guard.js";
import type { AgentJobRow } from "./job-store.js";
import type { RunInput, RunOutcome } from "./runner.js";

/** 调度器的外部依赖：全部注入，测试换成假的，生产在 Task 5.3 接线 */
export interface SchedulerDeps {
  run(input: RunInput): Promise<RunOutcome>;
  settings(): AgentSettings;
  /** 任务的工作目录：按 owner 现查，模板目录迁移过也不会用到旧路径 */
  workspaceOf(job: AgentJobRow): string;
  /** 重跑前清掉 Agent 产物（证据与宿主生成的文件留着） */
  resetWorkspace(job: AgentJobRow): void;
  onMessage?(jobId: string, message: SDKMessage): void;
  onIntercept?(jobId: string, denial: Denial & { tool: string; agentId?: string }): void;
  onChange?(job: AgentJobRow): void;
  /** 调度器自己出错时记一笔（pino 形状，生产传 app.log） */
  log?: { error(detail: unknown, message: string): void };
  clock?: Clock;
}

export class SchedulerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}

/** 一次待跑的运行 */
export interface Pending {
  jobId: string;
  prompt: string;
  resume?: string;
  budgetUsd: number;
  wallMs: number;
  /** 设置里的总时长，熔断原因里显示它（自动续跑时 wallMs 只是剩下的） */
  totalWallMs: number;
  /**
   * 这一次运行的起点。等额度之后的自动续跑属于同一次运行（墙钟和花费都接着算），
   * 所以要把原来的起点带过去，抽屉上的「用时」才不会归零重来。
   * 由人发起的开始 / 继续 / 重跑不带，execute 会记当下的时间。
   */
  runStartedAt?: string;
}

export interface Running {
  controller: AbortController;
  action?: "cancel" | "abort";
  done: Promise<void>;
}
