import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * 兼容端点的花费（Spec REQ-010）：SDK 按 Claude 的价目表估，对第三方模型不可信，改按档案单价
 * （美元 / 百万 token）× 每次调用的 token 用量折算。缓存读写的 token 按输入价算——宁可高估也不漏算。
 *
 * 用量取 assistant 消息上的 `message.usage`（每次 API 调用一份）：一次调用的多个内容块会各出一条
 * assistant 消息、id 相同，按 id 去重、同一 id 取较大的那份（后到的更完整）。只算这一段运行，
 * 不读 result 的 modelUsage——resume 的会话会把转录里之前的累计也带上，和已记下的花费重复
 */
export class PriceMeter {
  private readonly calls = new Map<string, number>();
  private anonymous = 0;

  constructor(private readonly pricing: { in: number; out: number }) {}

  observe(message: SDKMessage): void {
    if (message.type !== "assistant") return;
    const { usage } = message.message;
    if (!usage) return;
    // 有的代理不回消息 id：没法去重，就每条单算——宁可多算，不能不算、让 $ 熔断永远不跳（10.2 审查 S2-L1）
    const id = message.message.id || `anonymous-${(this.anonymous += 1)}`;
    const input =
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    const cost = (input * this.pricing.in + (usage.output_tokens ?? 0) * this.pricing.out) / 1_000_000;
    this.calls.set(id, Math.max(this.calls.get(id) ?? 0, cost));
  }

  /** 这一段运行到目前为止的折算花费（美元） */
  get cost(): number {
    let total = 0;
    for (const value of this.calls.values()) total += value;
    return total;
  }
}
