import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SDK 的 query 换成可控的假会话：验 runner 自己的逻辑，不开真会话、不花额度。
 * 假会话照真 SDK 的流式输入模式行事（scripts/spike-interrupt-cost.mjs 实测）：
 * interrupt() 之后吐一条带花费的 error_during_execution result；options.abortController
 * 被掐就抛 "Operation aborted"。
 */
interface Script {
  messages: unknown[];
  throwAfter?: number;
  throwWith?: Error;
  /** 为 true 时假会话吐完 messages 不结束，一直等 interrupt 或硬停 */
  hang?: boolean;
  /** interrupt() 之后吐的 result；undefined = interrupt 没反应（逼出兜底硬停） */
  onInterrupt?: unknown;
}
const script: Script = { messages: [] };
const seen = {
  options: [] as Record<string, unknown>[],
  prompts: [] as unknown[],
  interrupts: 0,
  closes: 0,
  registered: [] as unknown[][],
  killed: [] as (number | undefined)[],
};
/** 假会话起的真子进程（验 spawnClaudeCodeProcess 那条通路），用完要收掉 */
let spawned: { pid?: number; kill(): void } | undefined;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    seen.options.push(options);
    // 真 SDK 会用宿主给的 spawn 起 Claude Code 进程：这里起个短命的 node 顶替
    const spawnFn = options.spawnClaudeCodeProcess as
      ((o: Record<string, unknown>) => { pid?: number; kill(): void }) | undefined;
    spawned = spawnFn?.({ command: process.execPath, args: ["-e", "setTimeout(()=>{},3000)"], env: process.env });
    let wake: () => void = () => {};
    let interrupted = false;
    const hard = options.abortController as AbortController;
    const iterator = (async function* () {
      // 真 SDK 会读输入流：拿到第一条用户消息
      for await (const m of prompt) {
        seen.prompts.push(m);
        break;
      }
      for (let i = 0; i < script.messages.length; i++) {
        if (script.throwAfter === i) throw script.throwWith ?? new Error("boom");
        yield script.messages[i];
      }
      if (script.throwAfter === script.messages.length) throw script.throwWith ?? new Error("boom");
      while (script.hang) {
        if (interrupted && script.onInterrupt) {
          yield script.onInterrupt;
          return;
        }
        if (hard.signal.aborted) throw new Error("Operation aborted");
        await new Promise<void>((r) => {
          wake = r;
          hard.signal.addEventListener("abort", () => r(), { once: true });
        });
      }
    })();
    return Object.assign(iterator, {
      interrupt: () => {
        seen.interrupts++;
        interrupted = true;
        wake();
        return Promise.resolve(undefined);
      },
      close: () => {
        seen.closes++;
      },
    });
  },
}));
vi.mock("../lib/procs.js", () => ({
  AGENT_LABEL: "agent",
  procs: {
    register: (...args: unknown[]) => seen.registered.push(args),
    killTree: (pid: number) => seen.killed.push(pid),
  },
}));
vi.mock("./plugin.js", () => ({ ensureAgentPlugin: () => "C:/data/agent-plugin", HYPIT_SKILL: "clone-studio:hypit" }));
vi.mock("./hypit-bin.js", () => ({ ensureHypitBin: () => "C:/data/agent-bin" }));

const { runAgent, STOP_GRACE_MS } = await import("./runner.js");

const init = { type: "system", subtype: "init", session_id: "sess-9" };
const assistant = { type: "assistant", message: { content: [] } };
const result = { type: "result", subtype: "success", total_cost_usd: 0.04, is_error: false };
const interruptResult = { type: "result", subtype: "error_during_execution", total_cost_usd: 0.011, errors: [] };

function run(extra: { stopSignal?: AbortSignal; subject?: { kind: string; id: string } } = {}) {
  const got: SDKMessage[] = [];
  const outcome = runAgent({
    workspace: "C:/data/ws",
    maxBudgetUsd: 5,
    prompt: "复刻",
    onIntercept: () => {},
    onMessage: (m) => got.push(m),
    ...extra,
  });
  return { outcome, got };
}

beforeEach(() => {
  script.messages = [];
  delete script.throwAfter;
  delete script.throwWith;
  delete script.hang;
  delete script.onInterrupt;
  seen.options.length = 0;
  seen.prompts.length = 0;
  seen.interrupts = 0;
  seen.closes = 0;
  seen.registered.length = 0;
  seen.killed.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  spawned?.kill();
  spawned = undefined;
});

describe("runAgent", () => {
  it("拿到会话 id 与 result，每条消息都交给调用方，结束后关掉会话", async () => {
    script.messages = [init, assistant, result];
    const { outcome, got } = run();
    const o = await outcome;
    expect(o.sessionId).toBe("sess-9");
    expect(o.result).toMatchObject({ subtype: "success", total_cost_usd: 0.04 });
    expect(o.error).toBeUndefined();
    expect(got).toHaveLength(3);
    expect(seen.closes).toBe(1);
  });

  it("subject 原样登记进 procs：删对象时按它找得到这个会话（复审 S2-L1）", async () => {
    script.messages = [init, result];
    await run({ subject: { kind: "template", id: "t-7" } }).outcome;
    expect(seen.registered[0]).toEqual([expect.anything(), "agent", { kind: "template", id: "t-7" }]);
  });

  it("流式输入：任务提示作为一条用户消息发出", async () => {
    script.messages = [init, result];
    await run().outcome;
    expect(seen.prompts).toEqual([
      expect.objectContaining({ type: "user", message: { role: "user", content: "复刻" }, parent_tool_use_id: null }),
    ]);
  });

  it("会话配置走 buildSessionOptions，并由宿主自己 spawn Claude Code（登记进 procs）", async () => {
    script.messages = [init, result];
    await run().outcome;
    const opts = seen.options[0] as { plugins: unknown; hooks: { PreToolUse: unknown[] } } & Record<string, unknown>;
    expect(opts.plugins).toEqual([{ type: "local", path: "C:/data/agent-plugin" }]);
    expect(opts.hooks.PreToolUse).toHaveLength(1);
    expect(typeof opts.spawnClaudeCodeProcess).toBe("function");
    // 进程登记进 procs：后端退出时统一收尸，删对象时按 subject 找得到
    expect(seen.registered[0]).toEqual([expect.anything(), "agent", undefined]);
    expect(opts.abortController).toBeInstanceOf(AbortController);
  });

  it("宿主要停：调 interrupt()，拿到带花费的 result，标 aborted（复审 S2-M1）", async () => {
    script.messages = [init, assistant];
    script.hang = true;
    script.onInterrupt = interruptResult;
    const stop = new AbortController();
    const { outcome, got } = run({ stopSignal: stop.signal });
    await new Promise((r) => setImmediate(r));
    stop.abort();
    const o = await outcome;
    expect(seen.interrupts).toBe(1);
    expect(o.aborted).toBe(true);
    expect(o.result).toMatchObject({ total_cost_usd: 0.011 });
    expect(got.at(-1)).toMatchObject({ type: "result" });
    // 没走到兜底硬停
    expect((seen.options[0]?.abortController as AbortController).signal.aborted).toBe(false);
  });

  it("传进来的停止信号已经是中止状态：立刻停，不白跑一场（复审 S2-L7）", async () => {
    script.messages = [init];
    script.hang = true;
    script.onInterrupt = interruptResult;
    const stop = new AbortController();
    stop.abort();
    const o = await run({ stopSignal: stop.signal }).outcome;
    expect(o.aborted).toBe(true);
    // 还没收到 init 就停：走硬停那条，不等 interrupt
    expect(seen.interrupts).toBe(0);
    expect(seen.killed).toEqual([spawned?.pid]);
  });

  it("会话还没起来就要停：不等 interrupt，直接硬停（复审 S2-M3）", async () => {
    script.messages = []; // 没有 init
    script.hang = true;
    script.onInterrupt = interruptResult;
    const stop = new AbortController();
    const { outcome } = run({ stopSignal: stop.signal });
    await new Promise((r) => setImmediate(r));
    stop.abort();
    const o = await outcome;
    expect(seen.interrupts).toBe(0);
    expect((seen.options[0]?.abortController as AbortController).signal.aborted).toBe(true);
    expect(seen.killed).toEqual([spawned?.pid]);
    expect(o.aborted).toBe(true);
  });

  it("interrupt 没反应：宽限到了就硬停，报 error 且标 aborted", async () => {
    vi.useFakeTimers();
    script.messages = [init];
    script.hang = true;
    const stop = new AbortController();
    const { outcome } = run({ stopSignal: stop.signal });
    await vi.advanceTimersByTimeAsync(0);
    stop.abort();
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect((seen.options[0]?.abortController as AbortController).signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const o = await outcome;
    expect((seen.options[0]?.abortController as AbortController).signal.aborted).toBe(true);
    expect(o.aborted).toBe(true);
    expect(o.error).toContain("Operation aborted");
    // 硬停还要连子孙一起强杀：只掐 SDK 的话，Bash 起的子进程会活到自己结束（实测）
    expect(seen.killed).toEqual([spawned?.pid]);
  });

  it("调用方的 onMessage 抛（落库失败）：单独报 callbackError，不吞，也不掐断后续消息", async () => {
    script.messages = [init, assistant, result];
    const types: string[] = [];
    const o = await runAgent({
      workspace: "C:/data/ws",
      maxBudgetUsd: 5,
      prompt: "复刻",
      onIntercept: () => {},
      onMessage: (m) => {
        types.push(m.type);
        if (m.type === "assistant") throw new Error("database is locked");
      },
    });
    expect(o.callbackError).toBe("database is locked");
    expect(o.result).toMatchObject({ subtype: "success" });
    expect(types).toEqual(["system", "assistant", "result"]);
  });

  it("没拿到 result 就抛（进程起不来）：报 error，保留已拿到的会话 id", async () => {
    script.messages = [init, assistant];
    script.throwAfter = 2;
    script.throwWith = new Error("Claude Code process exited with code 1");
    const o = await run().outcome;
    expect(o.sessionId).toBe("sess-9");
    expect(o.result).toBeUndefined();
    expect(o.error).toContain("exited with code 1");
    expect(o.aborted).toBeUndefined();
  });
});
