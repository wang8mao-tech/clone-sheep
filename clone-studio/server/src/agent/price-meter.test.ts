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

  it("不是 assistant 的消息（result 的累计值之类）不算", () => {
    const meter = new PriceMeter({ in: 1, out: 1 });
    meter.observe({
      type: "result",
      subtype: "success",
      total_cost_usd: 99,
      usage: { input_tokens: 9e9 },
    } as unknown as SDKMessage);
    expect(meter.cost).toBe(0);
  });
});
