import type { FastifyReply } from "fastify";

export interface SseEvent {
  /** 事件序号，前端断线重连时带 Last-Event-ID 回来补发 */
  id: number;
  /** 主题：`template:<id>`、`job:<id>`、`global` 等 */
  topic: string;
  event: string;
  data: unknown;
}

interface Subscriber {
  topics: ReadonlySet<string>;
  reply: FastifyReply;
}

/**
 * 按主题订阅的 SSE 通道。
 *
 * 断线重连补发靠内存环形缓冲：进程重启后缓冲清空，此时前端拿不到旧事件，
 * 必须回落到拉一次全量快照。这是刻意的取舍——事件只是"快照失效"的提示，
 * 真相永远在数据库里，不靠事件流累积状态。
 */
export class SseHub {
  private seq = 0;
  private readonly subscribers = new Set<Subscriber>();
  private readonly buffer: SseEvent[] = [];

  constructor(private readonly bufferSize = 500) {}

  subscribe(reply: FastifyReply, topics: readonly string[], lastEventId?: number): () => void {
    const sub: Subscriber = { topics: new Set(topics), reply };
    this.subscribers.add(sub);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 本地部署没有反代，但写上不吃亏
      "X-Accel-Buffering": "no",
    });
    // 立刻发一条注释行，让浏览器确认连接已建立
    reply.raw.write(": connected\n\n");

    if (lastEventId !== undefined) {
      for (const evt of this.buffer) {
        if (evt.id > lastEventId && sub.topics.has(evt.topic)) this.write(sub, evt);
      }
    }

    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
    }, 15_000);

    const close = (): void => {
      clearInterval(heartbeat);
      this.subscribers.delete(sub);
    };
    reply.raw.on("close", close);
    return close;
  }

  /**
   * `buffer: false` 的事件不进重放缓冲。给 Agent 消息用：它每条消息一个事件，量大，
   * 而且本来就能按 seq 从库里补回来；进了缓冲只会把别的主题（侧栏、证据流水线）
   * 需要重放的事件挤掉（Task 5.3 复审 M-6）。
   */
  publish(topic: string, event: string, data: unknown, options?: { buffer?: boolean }): SseEvent {
    this.seq += 1;
    const evt: SseEvent = { id: this.seq, topic, event, data };
    if (options?.buffer !== false) {
      this.buffer.push(evt);
      if (this.buffer.length > this.bufferSize) this.buffer.shift();
    }
    for (const sub of this.subscribers) {
      if (sub.topics.has(topic)) this.write(sub, evt);
    }
    return evt;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  private write(sub: Subscriber, evt: SseEvent): void {
    if (sub.reply.raw.writableEnded) return;
    sub.reply.raw.write(
      `id: ${evt.id}\nevent: ${evt.event}\ndata: ${JSON.stringify({ topic: evt.topic, data: evt.data })}\n\n`,
    );
  }
}

export const sseHub = new SseHub();
