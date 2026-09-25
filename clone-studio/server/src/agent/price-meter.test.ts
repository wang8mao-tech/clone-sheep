import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { PriceMeter } from "./price-meter.js";

/** 兼容端点按单价折算花费（REQ-010） */

const assistant = (id: string, usage: Record<string, number>) =>
  ({ type: "assistant", message: { id, usage, content: [] } }) as unknown as SDKMessage;

describe("PriceMeter", () => {
  it("输入（含缓存读写）× 输入价 + 输出 × 输出价，按百万 token", () => {
    const meter = new PriceMeter({ in: 2, out: 10 });
    meter.observe(
      assistant("m1", {
        input_tokens: 100_000,
        cache_creation_input_tokens: 50_000,
        cache_read_input_tokens: 350_000,
        output_tokens: 20_000,
      }),
    );
    // 500k × $2/M + 20k × $10/M = 1.0 + 0.2
    expect(meter.cost).toBeCloseTo(1.2);
  });

  it("同一次调用的多条 assistant 消息（id 相同）只算一次，取较大的那份", () => {
    const meter = new PriceMeter({ in: 1, out: 1 });
    meter.observe(assistant("m1", { input_tokens: 1_000_000, output_tokens: 10 }));
    meter.observe(assistant("m1", { input_tokens: 1_000_000, output_tokens: 500_000 }));
    meter.observe(assistant("m1", { input_tokens: 1_000_000, output_tokens: 10 }));
    expect(meter.cost).toBeCloseTo(1.5);
    meter.observe(assistant("m2", { input_tokens: 0, output_tokens: 1_000_000 }));
    expect(meter.cost).toBeCloseTo(2.5);
  });

  it("代理不回消息 id：每条单算，不漏（10.2 审查 S2-L1）", () => {
    const meter = new PriceMeter({ in: 1, out: 0 });
    meter.observe(assistant("", { input_tokens: 1_000_000, output_tokens: 0 }));
    meter.observe(assistant("", { input_tokens: 1_000_000, output_tokens: 0 }));
    expect(meter.cost).toBeCloseTo(2);
  });

  it("result 的 total_cost_usd / modelUsage（resume 会带上转录累计）不认；别的消息不算", () => {
    const meter = new PriceMeter({ in: 1, out: 1 });
    meter.observe({
      type: "result",
      subtype: "success",
      total_cost_usd: 99,
      modelUsage: { m: { inputTokens: 9e9, outputTokens: 9e9, costUSD: 99 } },
    } as unknown as SDKMessage);
    meter.observe({ type: "user", message: { usage: { input_tokens: 9e9 } } } as unknown as SDKMessage);
    expect(meter.cost).toBe(0);
  });
});

describe("PriceMeter：流式下 assistant 的输出 token 不全（Task 10.5 假端点实测）", () => {
  it("result 的 usage（这一段的合计）更全就以它为准；assistant 算出的更多时仍取大的", () => {
    const meter = new PriceMeter({ in: 1, out: 10 });
    meter.observe(assistant("m1", { input_tokens: 3_000_000, output_tokens: 1 }));
    expect(meter.cost).toBeCloseTo(3);
    meter.observe({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 3_000_000, output_tokens: 1_000_000 },
    } as unknown as SDKMessage);
    expect(meter.cost).toBeCloseTo(13);
    const other = new PriceMeter({ in: 1, out: 1 });
    other.observe(assistant("a", { input_tokens: 2_000_000, output_tokens: 0 }));
    other.observe({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    } as unknown as SDKMessage);
    expect(other.cost).toBeCloseTo(2);
  });
});

describe("PriceMeter：流式事件（10.4 审查 S2-M2）", () => {
  const ev = (event: Record<string, unknown>, parent: string | null = null) =>
    ({ type: "stream_event", event, parent_tool_use_id: parent }) as unknown as SDKMessage;

  it("message_start 给输入、message_delta 给到目前为止的输出：运行中就算得出输出", () => {
    const meter = new PriceMeter({ in: 1, out: 10 });
    meter.observe(
      ev({ type: "message_start", message: { id: "m1", usage: { input_tokens: 1_000_000, output_tokens: 1 } } }),
    );
    expect(meter.cost).toBeCloseTo(1);
    meter.observe(ev({ type: "message_delta", usage: { output_tokens: 200_000 } }));
    meter.observe(ev({ type: "message_delta", usage: { output_tokens: 500_000 } }));
    expect(meter.cost).toBeCloseTo(6);
    // 同一次调用随后到的 assistant 消息（输出只记了 1）不会把它拉低、也不会重复算
    meter.observe(assistant("m1", { input_tokens: 1_000_000, output_tokens: 1 }));
    expect(meter.cost).toBeCloseTo(6);
  });

  it("主循环与工具里的子会话各记各的：message_delta 落到自己那条线上当前的消息", () => {
    const meter = new PriceMeter({ in: 0, out: 1 });
    meter.observe(ev({ type: "message_start", message: { id: "main-1", usage: { output_tokens: 0 } } }));
    meter.observe(ev({ type: "message_start", message: { id: "sub-1", usage: { output_tokens: 0 } } }, "tool-1"));
    meter.observe(ev({ type: "message_delta", usage: { output_tokens: 1_000_000 } }, "tool-1"));
    meter.observe(ev({ type: "message_delta", usage: { output_tokens: 2_000_000 } }));
    expect(meter.cost).toBeCloseTo(3);
  });

  it("没配上 message_start 的 message_delta 不算（不知道是哪次调用）", () => {
    const meter = new PriceMeter({ in: 1, out: 1 });
    meter.observe(ev({ type: "message_delta", usage: { output_tokens: 9_000_000 } }));
    expect(meter.cost).toBe(0);
  });
});

describe("PriceMeter：代理不回消息 id 的流式事件（10.4 第二轮审查 S2-M-A）", () => {
  const ev = (event: Record<string, unknown>) =>
    ({ type: "stream_event", event, parent_tool_use_id: null }) as unknown as SDKMessage;

  it("message_start 没 id：照样接上这次调用的 message_delta；下一次调用不会并进上一次", () => {
    const meter = new PriceMeter({ in: 1, out: 1 });
    meter.observe(ev({ type: "message_start", message: { usage: { input_tokens: 1_000_000 } } }));
    meter.observe(ev({ type: "message_delta", usage: { output_tokens: 5_000_000 } }));
    expect(meter.cost).toBeCloseTo(6);
    meter.observe(ev({ type: "message_start", message: { usage: { input_tokens: 1_000_000 } } }));
    meter.observe(ev({ type: "message_delta", usage: { output_tokens: 1_000_000 } }));
    expect(meter.cost).toBeCloseTo(8);
  });
});
