import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * 兼容端点的花费（Spec REQ-010）：SDK 按 Claude 的价目表估，对第三方模型不可信，改按档案单价
 * （美元 / 百万 token）× 这一段运行的 token 用量折算。缓存读写的 token 按输入价算——宁可高估也不漏算。
 *
 * 用量从三处来，每次 API 调用（消息 id）各算一份、取大的，再加总；和 result 的合计比，取大的：
 * - 流式事件（会话开了 includePartialMessages，只给按单价算的档案开）：message_start 给 id 与输入，
 *   message_delta 给这次调用到目前为止的输出——运行中就看得到输出，$ 熔断才判得准（10.4 审查 S2-M2）
 * - assistant 消息上的 `message.usage`：没开流式事件时的退路。**它的输出 token 不全**：取自 message_start，
 *   输出只记了 1（Task 10.5 假端点实测：assistant 里 output_tokens=1，result 里是 1,000,000）
 * - 收尾 result 的 `usage`（主循环这一段 turn 的合计，SDK 注明 per-turn）。
 *   不读 result 的 modelUsage / total_cost_usd：resume 的会话会把转录里之前的累计也带上，和已记下的花费重复
 *
 * 另加自动 / 手动压缩：压缩那次调用不出 assistant 消息也不出流式事件，result 的 usage 也不含它
 * （Task 10.5 假端点实测：resume 时先压缩，上游收到两次调用、只记了一次）。按 compact_boundary 的
 * pre_tokens（压缩时读入的整段上下文）记输入、post_tokens（压缩后的摘要）记输出，单独加在上面。
 */
interface Usage {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number | null;
}

export class PriceMeter {
  private readonly calls = new Map<string, number>();
  /** 流式事件里每次调用累到的用量（message_delta 只给增量字段，要和 message_start 的合起来） */
  private readonly streams = new Map<string, Required<{ [K in keyof Usage]: number }>>();
  /** 每条会话线（主循环 / 某个工具调用里的子会话）当前在收的消息 id：message_delta 不带 id */
  private readonly current = new Map<string, string>();
  private anonymous = 0;
  private settled = 0;
  private compactions = 0;

  constructor(private readonly pricing: { in: number; out: number }) {}

  private priced(usage: Usage): number {
    const input =
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    return (input * this.pricing.in + (usage.output_tokens ?? 0) * this.pricing.out) / 1_000_000;
  }

  private count(id: string, usage: Usage): void {
    this.calls.set(id, Math.max(this.calls.get(id) ?? 0, this.priced(usage)));
  }

  private streamEvent(
    line: string,
    event: { type?: string; message?: { id?: string; usage?: Usage }; usage?: Usage },
  ): void {
    if (event.type === "message_start") {
      // 代理不回消息 id 的：给一个本段内唯一的 id，这次调用的 message_delta 仍然记得上（10.4 第二轮审查 S2-M-A）
      const id = event.message?.id || `stream-${line}-${(this.anonymous += 1)}`;
      this.current.set(line, id);
      this.merge(id, event.message?.usage ?? {});
      return;
    }
    const id = this.current.get(line);
    if (event.type === "message_delta" && id && event.usage) this.merge(id, event.usage);
  }

  /** 流式用量按字段取大（message_delta 的数是这次调用到目前为止的累计） */
  private merge(id: string, usage: Usage): void {
    const prev = this.streams.get(id) ?? {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    };
    const next = {
      input_tokens: Math.max(prev.input_tokens, usage.input_tokens ?? 0),
      cache_creation_input_tokens: Math.max(prev.cache_creation_input_tokens, usage.cache_creation_input_tokens ?? 0),
      cache_read_input_tokens: Math.max(prev.cache_read_input_tokens, usage.cache_read_input_tokens ?? 0),
      output_tokens: Math.max(prev.output_tokens, usage.output_tokens ?? 0),
    };
    this.streams.set(id, next);
    this.count(id, next);
  }

  observe(message: SDKMessage): void {
    if (message.type === "stream_event") {
      this.streamEvent(message.parent_tool_use_id ?? "main", message.event);
      return;
    }
    if (message.type === "result") {
      if (message.usage) this.settled = Math.max(this.settled, this.priced(message.usage));
      return;
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      const { pre_tokens, post_tokens } = message.compact_metadata;
      this.compactions += this.priced({ input_tokens: pre_tokens, output_tokens: post_tokens ?? 0 });
      return;
    }
    if (message.type !== "assistant") return;
    const { usage } = message.message;
    if (!usage) return;
    // 有的代理不回消息 id：没法去重，就每条单算——宁可多算，不能不算、让 $ 熔断永远不跳（10.2 审查 S2-L1）
    const id = message.message.id || `anonymous-${(this.anonymous += 1)}`;
    this.count(id, usage);
  }

  /** 这一段运行到目前为止的折算花费（美元） */
  get cost(): number {
    let streamed = 0;
    for (const value of this.calls.values()) streamed += value;
    return Math.max(streamed, this.settled) + this.compactions;
  }
}
