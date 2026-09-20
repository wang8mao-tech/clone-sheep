import { describe, expect, it, vi } from "vitest";
import { SseHub } from "./sse.js";

/** 只实现 SseHub 用到的那几个 raw 方法，不引入真的 http 层 */
function fakeReply() {
  const written: string[] = [];
  const handlers: Record<string, Array<() => void>> = {};
  const raw = {
    writableEnded: false,
    writeHead: vi.fn(),
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    on: (event: string, cb: () => void) => {
      (handlers[event] ??= []).push(cb);
    },
  };
  return {
    reply: { raw } as never,
    written,
    close: () => {
      raw.writableEnded = true;
      for (const cb of handlers.close ?? []) cb();
    },
  };
}

function frames(written: string[]): string[] {
  return written.filter((w) => w.startsWith("id: "));
}

describe("SseHub", () => {
  it("只把事件发给订阅了该主题的连接", () => {
    const hub = new SseHub();
    const a = fakeReply();
    const b = fakeReply();
    hub.subscribe(a.reply, ["template:1"]);
    hub.subscribe(b.reply, ["template:2"]);

    hub.publish("template:1", "template", { status: "cloning" });

    expect(frames(a.written)).toHaveLength(1);
    expect(frames(b.written)).toHaveLength(0);
    expect(frames(a.written)[0]).toContain("event: template");
    expect(frames(a.written)[0]).toContain('"status":"cloning"');
  });

  it("按 Last-Event-ID 补发断线期间错过的事件，且只补该主题的", () => {
    const hub = new SseHub();
    const first = fakeReply();
    hub.subscribe(first.reply, ["job:1"]);

    const e1 = hub.publish("job:1", "job", { seq: 1 });
    hub.publish("other", "job", { seq: 2 });
    const e3 = hub.publish("job:1", "job", { seq: 3 });

    const reconnected = fakeReply();
    hub.subscribe(reconnected.reply, ["job:1"], e1.id);

    const replayed = frames(reconnected.written);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toContain(`id: ${e3.id}`);
    expect(replayed[0]).toContain('"seq":3');
  });

  it("缓冲满了丢最老的，补发拿不到就该拿不到，不假装完整", () => {
    const hub = new SseHub(2);
    const dropped = hub.publish("t", "e", { n: 1 });
    hub.publish("t", "e", { n: 2 });
    hub.publish("t", "e", { n: 3 });

    const late = fakeReply();
    hub.subscribe(late.reply, ["t"], dropped.id - 1);

    // 缓冲只剩 2、3，第 1 条已经滚掉
    expect(frames(late.written)).toHaveLength(2);
    expect(frames(late.written).join("")).not.toContain('"n":1');
  });

  it("连接关闭后从订阅表里摘掉，不再往死连接写", () => {
    const hub = new SseHub();
    const a = fakeReply();
    hub.subscribe(a.reply, ["t"]);
    expect(hub.subscriberCount).toBe(1);

    a.close();
    expect(hub.subscriberCount).toBe(0);

    hub.publish("t", "e", {});
    expect(frames(a.written)).toHaveLength(0);
  });
});
