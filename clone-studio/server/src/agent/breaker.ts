import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * 一次 Agent 运行的熔断与限流判断（Spec REQ-003）。
 *
 * 只看消息流和时钟，不碰数据库、不碰进程：判出结论就调一次 onVerdict，由调度器去中止
 * 会话、改状态。每次运行（含等待额度后的自动续跑）一个实例。
 *
 * - 墙钟：设置里的 agent_timeout_minutes。自动续跑接着用剩下的时间，不重新计。
 * - 卡死：10 分钟无任何新消息。前台长命令期间 SDK 约每 30 秒发一条 `tool_progress` 心跳
 *   （2026-09-23 实测，scripts/spike-tool-progress.mjs），所以跑十几分钟的转写不会被误判；
 *   命令本身挂死但心跳还在的，靠墙钟兜底。
 * - 同一条命令连续失败 5 次：按命令原文计数，这条命令成功一次就清零。被 guard 拒绝的调用
 *   也以失败结果回来，Agent 反复撞同一条被禁命令同样会熔断。
 * - 花费：SDK 原生 maxBudgetUsd 触发的 `error_max_budget_usd` 结果，这里只负责认出来。
 * - 订阅限流：`rate_limit_event` 的 status 为 rejected，或助手消息带 `error: "rate_limit"`（SDK 的
 *   另一条通道，没有 rejected 事件时靠它）→ 等待额度，到重置时间自动续跑，不算熔断。
 *   rejected 时即使账户开了超额（overageStatus allowed）也停：v1 不替用户花超额的钱。
 *   `api_retry` 里的 rate_limit 是 SDK 自己在重试，不管。
 */

export type TripReason = "timeout" | "idle" | "repeated_failure" | "budget";

export type Verdict = { kind: "trip"; reason: TripReason; detail: string } | { kind: "quota"; resumeAt: Date };

export interface BreakerLimits {
  /** 这次运行还剩多少墙钟时间 */
  wallMs: number;
  /** 设置里的总时长，只用于熔断原因的文字（自动续跑时剩余时间比它短） */
  totalWallMs?: number;
  idleMs?: number;
  maxSameFailures?: number;
}

export const IDLE_MS = 10 * 60_000;
export const MAX_SAME_FAILURES = 5;
/** 限流事件没给重置时间时，隔多久再试 */
export const QUOTA_FALLBACK_MS = 30 * 60_000;
/** 重置时间已过（或就在眼前）时至少等这么久，免得额度没恢复就立刻重开进程、反复撞墙 */
export const QUOTA_MIN_WAIT_MS = 60_000;
/** 上限：单位判断错了（比如给的是微秒）会算出一个很远的时间，setTimeout 溢出后反而立刻触发 */
export const QUOTA_MAX_WAIT_MS = 24 * 60 * 60_000;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** 会被当成「命令」计数的工具：Bash，以及 Windows 上的 PowerShell 工具 */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export class Breaker {
  private readonly idleMs: number;
  private readonly maxSameFailures: number;
  private readonly startedAt: number;
  private wallTimer: unknown;
  private idleTimer: unknown;
  private done = false;
  private readonly commands = new Map<string, string>();
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly limits: BreakerLimits,
    private readonly onVerdict: (verdict: Verdict) => void,
    private readonly clock: Clock = systemClock,
  ) {
    this.idleMs = limits.idleMs ?? IDLE_MS;
    this.maxSameFailures = limits.maxSameFailures ?? MAX_SAME_FAILURES;
    this.startedAt = clock.now();
    this.wallTimer = clock.setTimeout(
      () =>
        this.fire({
          kind: "trip",
          reason: "timeout",
          detail: `运行超过 ${minutes(limits.totalWallMs ?? limits.wallMs)} 分钟`,
        }),
      Math.max(0, limits.wallMs),
    );
    this.armIdle();
  }

  /** 已经跑了多久：自动续跑时拿它算剩余墙钟 */
  elapsedMs(): number {
    return this.clock.now() - this.startedAt;
  }

  /** 外部判出来的熔断（按档案单价折算的花费到上限，REQ-010）：同样只报一次 */
  trip(reason: TripReason, detail: string): void {
    this.fire({ kind: "trip", reason, detail });
  }

  observe(message: SDKMessage): void {
    if (this.done) return;
    this.armIdle();
    if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected") {
      this.fire({ kind: "quota", resumeAt: resumeTime(message.rate_limit_info.resetsAt, this.clock.now()) });
      return;
    }
    if (message.type === "assistant" && message.error === "rate_limit") {
      this.fire({ kind: "quota", resumeAt: resumeTime(undefined, this.clock.now()) });
      return;
    }
    if (message.type === "result" && message.subtype === "error_max_budget_usd") {
      this.fire({ kind: "trip", reason: "budget", detail: "花费达到上限" });
      return;
    }
    if (message.type === "assistant") {
      for (const block of contentBlocks(message.message)) {
        if (block.type === "tool_use" && SHELL_TOOLS.has(String(block.name)) && isCommandInput(block.input)) {
          this.commands.set(String(block.id), block.input.command.trim());
        }
      }
    }
    if (message.type === "user") {
      for (const block of contentBlocks(message.message)) {
        if (block.type === "tool_result") this.countResult(String(block.tool_use_id), block.is_error === true);
      }
    }
  }

  /** 运行结束（不管怎么结束的）都要调，清掉计时器 */
  stop(): void {
    this.done = true;
    this.clock.clearTimeout(this.wallTimer);
    this.clock.clearTimeout(this.idleTimer);
  }

  private countResult(toolUseId: string, failed: boolean): void {
    const command = this.commands.get(toolUseId);
    if (command === undefined) return;
    this.commands.delete(toolUseId);
    if (!failed) {
      this.failures.delete(command);
      return;
    }
    const count = (this.failures.get(command) ?? 0) + 1;
    this.failures.set(command, count);
    if (count >= this.maxSameFailures) {
      this.fire({ kind: "trip", reason: "repeated_failure", detail: `同一条命令连续失败 ${count} 次：${command}` });
    }
  }

  private armIdle(): void {
    this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = this.clock.setTimeout(
      () => this.fire({ kind: "trip", reason: "idle", detail: `${minutes(this.idleMs)} 分钟没有任何新消息` }),
      this.idleMs,
    );
  }

  private fire(verdict: Verdict): void {
    if (this.done) return;
    this.stop();
    this.onVerdict(verdict);
  }
}

/**
 * resetsAt 的单位 SDK 类型里没写。按量级判断：小于 1e12 的是 Unix 秒（1e12 毫秒是 2001 年，
 * 秒要到 33658 年才到这个数），否则当毫秒。没给就隔 30 分钟再试；给的时间已经过了，
 * 至少等 1 分钟。
 */
export function resumeTime(resetsAt: number | undefined, now: number): Date {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return new Date(now + QUOTA_FALLBACK_MS);
  }
  const at = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  return new Date(Math.min(Math.max(at, now + QUOTA_MIN_WAIT_MS), now + QUOTA_MAX_WAIT_MS));
}

interface Block {
  type: string;
  [key: string]: unknown;
}

function contentBlocks(message: unknown): Block[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content)
    ? content.filter((b): b is Block => typeof b === "object" && b !== null && "type" in b)
    : [];
}

function isCommandInput(input: unknown): input is { command: string } {
  return typeof input === "object" && input !== null && typeof (input as { command?: unknown }).command === "string";
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}
