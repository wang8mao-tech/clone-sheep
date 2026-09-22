import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** SDK 的 query 换成可控的假流：验 runner 自己的逻辑，不开真会话、不花额度 */
const script: { messages: unknown[]; throwAfter?: number; throwWith?: Error } = { messages: [] };
const seenOptions: unknown[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: unknown }) => {
    seenOptions.push(options);
    return (async function* () {
      for (let i = 0; i < script.messages.length; i++) {
        if (script.throwAfter === i) throw script.throwWith ?? new Error("boom");
        yield script.messages[i];
      }
      if (script.throwAfter === script.messages.length) throw script.throwWith ?? new Error("boom");
    })();
  },
}));
vi.mock("./plugin.js", () => ({ ensureAgentPlugin: () => "C:/data/agent-plugin", HYPIT_SKILL: "clone-studio:hypit" }));

const { runAgent } = await import("./runner.js");

const init = { type: "system", subtype: "init", session_id: "sess-9" };
const assistant = { type: "assistant", message: { content: [] } };
const result = { type: "result", subtype: "success", total_cost_usd: 0.04, is_error: false };

function run() {
  const got: SDKMessage[] = [];
  const outcome = runAgent({
    workspace: "C:/data/ws",
    maxBudgetUsd: 5,
    prompt: "复刻",
    onIntercept: () => {},
    onMessage: (m) => got.push(m),
  });
  return { outcome, got };
}

beforeEach(() => {
  script.messages = [];
  delete script.throwAfter;
  delete script.throwWith;
  seenOptions.length = 0;
});

describe("runAgent", () => {
  it("调用方的 onMessage 抛（落库失败）：单独报 callbackError，不吞，也不掐断后续消息", async () => {
    script.messages = [init, assistant, result];
    const seen: string[] = [];
    const o = await runAgent({
      workspace: "C:/data/ws",
      maxBudgetUsd: 5,
      prompt: "复刻",
      onIntercept: () => {},
      onMessage: (m) => {
        seen.push(m.type);
        if (m.type === "assistant") throw new Error("database is locked");
      },
    });
    expect(o.callbackError).toBe("database is locked");
    expect(o.result).toMatchObject({ subtype: "success" });
    expect(seen).toEqual(["system", "assistant", "result"]);
  });

  it("被调用方中止：标 aborted", async () => {
    script.messages = [init, assistant];
    script.throwAfter = 2;
    script.throwWith = new Error("aborted by user");
    const abortController = new AbortController();
    abortController.abort();
    const o = await runAgent({
      workspace: "C:/data/ws",
      maxBudgetUsd: 5,
      prompt: "复刻",
      abortController,
      onIntercept: () => {},
      onMessage: () => {},
    });
    expect(o.aborted).toBe(true);
    expect(o.error).toContain("aborted");
  });

  it("拿到会话 id 与最后一条 result，每条消息都交给调用方", async () => {
    script.messages = [init, assistant, result];
    const { outcome, got } = run();
    const o = await outcome;
    expect(o.sessionId).toBe("sess-9");
    expect(o.result).toMatchObject({ subtype: "success", total_cost_usd: 0.04 });
    expect(o.error).toBeUndefined();
    expect(got).toHaveLength(3);
  });

  it("会话配置走 buildSessionOptions（带拦截 hook、插件目录）", async () => {
    script.messages = [init, result];
    await run().outcome;
    const opts = seenOptions[0] as { plugins: unknown; hooks: { PreToolUse: unknown[] } };
    expect(opts.plugins).toEqual([{ type: "local", path: "C:/data/agent-plugin" }]);
    expect(opts.hooks.PreToolUse).toHaveLength(1);
  });

  it("产出错误 result 后 SDK 又抛：以 result 为准，不当进程故障", async () => {
    script.messages = [init, { ...result, subtype: "error_max_budget_usd", is_error: true }];
    script.throwAfter = 2;
    const o = await run().outcome;
    expect(o.result).toMatchObject({ subtype: "error_max_budget_usd" });
    expect(o.error).toBeUndefined();
  });

  it("没拿到 result 就抛（进程起不来、被中止）：报 error，保留已拿到的会话 id", async () => {
    script.messages = [init, assistant];
    script.throwAfter = 2;
    script.throwWith = new Error("Claude Code process exited with code 1");
    const o = await run().outcome;
    expect(o.sessionId).toBe("sess-9");
    expect(o.result).toBeUndefined();
    expect(o.error).toContain("exited with code 1");
  });
});
