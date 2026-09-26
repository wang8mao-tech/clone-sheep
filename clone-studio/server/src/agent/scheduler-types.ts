import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSettings } from "./agent-settings.js";
import type { Clock } from "./breaker.js";
import type { Denial } from "./guard.js";
import type { AgentJobRow } from "./job-store.js";
import type { RunInput, RunOutcome } from "./runner.js";

/** `rework` 是验货打回：把人的意见 resume 进原会话（REQ-004），抽屉按它画「打回意见 #n」 */
export type RunKind = "start" | "continue" | "auto_resume" | "rework";

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
  /**
   * 一段运行开跑时，交给会话的那句话（Design-Brief §A.2「用户消息」）。会话走流式输入，SDK 不回显它，
   * 抽屉只能靠宿主自己记一笔。`start` 是任务第一次跑，`continue` 是人点的继续（含打回意见），
   * `auto_resume` 是等额度之后宿主自己续跑。
   */
  onRunStart?(jobId: string, run: { kind: RunKind; prompt: string }): void;
  /**
   * 这一段运行是宿主停下的（人点中止 / 取消、熔断、订阅限流），不是会话自己结束的。
   * `reason` 同 stop_reason 的写法；限流是 `awaiting_quota`。
   */
  onRunStop?(jobId: string, stop: { reason: string }): void;
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
   * 这一次运行在此之前已经跑掉的毫秒数。等额度之后的自动续跑属于同一次运行（墙钟和花费都
   * 接着算），把已经跑掉的时长带过去接着算，抽屉的「用时」才不会归零重来；等额度干等的
   * 几小时不算进去，和熔断实际用掉的墙钟对得上（复审 S1-M6）。
   * 由人发起的开始 / 继续 / 重跑不带，从 0 起算。
   * 用累计毫秒数而不是「把起点往后挪」：单个时间戳表达不了「等待期间用时冻住」——不挪会一路
   * 虚高，按计划等待时长预先挪又会变成未来时间、用时显示成负数（复审 S1-M1(r6)）。
   */
  elapsedMs?: number;
  /** 由人明说的运行类型（打回）。不给就按 elapsedMs / started_at 推 */
  kind?: RunKind;
}

export interface Running {
  controller: AbortController;
  action?: "cancel" | "abort";
  done: Promise<void>;
}
