import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { AgentSettings } from "./agent-settings.js";
import { fakeClock } from "./clock-test-kit.js";
import type { RunInput, RunOutcome } from "./runner.js";

/**
 * 调度器测试的公共底座：真临时库；Agent 会话换成手动控制的假 run——测试决定它吐什么消息、
 * 何时结束，中止信号到了就立刻以 aborted 结束，和真 runner 被 AbortController 掐掉时一样。
 */

let dataRoot = "";
let closeDb: (() => void) | undefined;

/** 在 describe 外调用一次：每个用例一个临时数据根，用完关库再删（Windows 上不关会 EPERM） */
export function useTempDataRoot(): void {
  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(tmpdir(), "cs-scheduler-"));
    process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
    vi.resetModules();
  });
  afterEach(() => {
    closeDb?.();
    closeDb = undefined;
    rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.CLONE_STUDIO_DATA_ROOT;
  });
}

export function currentDataRoot(): string {
  return dataRoot;
}

export interface Call {
  input: RunInput;
  emit(message: Record<string, unknown>): void;
  finish(outcome: RunOutcome): void;
  /** 这次运行到目前为止的累计花费：被停时 interrupt 吐的 result 带的就是它 */
  spent: number;
}

export interface SetupOptions {
  /** 假 run 不理会停止信号：验「会话赖着不停」那条路。可以中途用 setIgnoreStop 关掉 */
  ignoreStop?: boolean;
}

export async function setup(settings: Partial<AgentSettings> = {}, options: SetupOptions = {}) {
  const dbMod = await import("../db/index.js");
  const migrateMod = await import("../db/migrate.js");
  const store = await import("./job-store.js");
  const { Scheduler } = await import("./scheduler.js");
  closeDb = dbMod.closeDb;
  migrateMod.migrate();

  const calls: Call[] = [];
  const clock = fakeClock();
  const current: AgentSettings = { timeoutMinutes: 45, budgetUsd: 5, concurrency: 2, ...settings };
  const resets: string[] = [];
  /** 调度器转出来的消息与拦截记录（Task 5.3 会拿它们落库、推 SSE） */
  const forwarded: Array<{ jobId: string; type: string }> = [];
  const intercepts: Array<{ jobId: string; rule: string }> = [];
  /** 每段运行开跑时交给会话的那句话（抽屉的「用户消息」） */
  const runStarts: Array<{ jobId: string; kind: string; prompt: string }> = [];
  /** 宿主停下的那些段（抽屉据此把收尾的 result 当成「被停下」） */
  const runStops: Array<{ jobId: string; reason: string }> = [];
  let ignoreStop = options.ignoreStop ?? false;
  // 和真 runner 一样：被停时 interrupt() 吐一条带累计花费的 error_during_execution result，再以 aborted 结束
  const run = (input: RunInput) =>
    new Promise<RunOutcome>((resolve) => {
      const call: Call = {
        input,
        emit: (m) => input.onMessage(m as unknown as SDKMessage),
        finish: resolve,
        spent: 0,
      };
      // 赖着不停的那种：照常登记这次调用，只是不理会停止信号（既不吐 result 也不结束）
      if (!ignoreStop) {
        input.stopSignal?.addEventListener("abort", () => {
          const result = { type: "result", subtype: "error_during_execution", total_cost_usd: call.spent, errors: [] };
          call.emit(result);
          resolve({ aborted: true, result: result as never });
        });
      }
      calls.push(call);
    });
  const scheduler = new Scheduler({
    run,
    settings: () => current,
    workspaceOf: (job) => path.join(dataRoot, "ws", job.owner_id),
    onMessage: (jobId, message) => forwarded.push({ jobId, type: message.type }),
    onIntercept: (jobId, denial) => intercepts.push({ jobId, rule: denial.rule }),
    onRunStart: (jobId, run) => runStarts.push({ jobId, ...run }),
    onRunStop: (jobId, stop) => runStops.push({ jobId, ...stop }),
    resetWorkspace: (job) => resets.push(job.id),
    clock,
  });
  return {
    scheduler,
    store,
    calls,
    clock,
    current,
    resets,
    forwarded,
    intercepts,
    runStarts,
    runStops,
    migrateMod,
    dbMod,
    /** 之后开的会话理不理会停止信号 */
    setIgnoreStop: (value: boolean) => {
      ignoreStop = value;
    },
  };
}

export const flush = () => new Promise((r) => setImmediate(r));
export const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId });
export const success = (cost: number) => ({ type: "result", subtype: "success", total_cost_usd: cost, errors: [] });
export const job = (ownerId: string) => ({ ownerKind: "template" as const, ownerId, prompt: `复刻 ${ownerId}` });
