import { vi } from "vitest";

/**
 * 可控的 EventSource：用例自己决定什么时候「连上」、推什么事件。
 * setup.ts 里那个空壳永不连接，测不到「先订阅再拉」「每次连上都重对」这类顺序。
 */
export class ControlledEventSource extends EventTarget {
  static instances: ControlledEventSource[] = [];
  readyState = 0;
  closed = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;

  constructor(readonly url: string) {
    super();
    ControlledEventSource.instances.push(this);
  }

  /** 连上（首次或自动重连后） */
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  /** 推一条命名事件，帧格式同 server/src/lib/sse.ts：`{ topic, data }` */
  emit(event: string, topic: string, data: unknown): void {
    this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify({ topic, data }) }));
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  get topics(): string[] {
    return decodeURIComponent(new URL(this.url, "http://x").searchParams.get("topics") ?? "").split(",");
  }
}

/** 装上可控的 EventSource，返回「订阅了某主题、还开着的那一个」的查找函数 */
export function installEventSource(): (topic: string) => ControlledEventSource | undefined {
  ControlledEventSource.instances = [];
  vi.stubGlobal("EventSource", ControlledEventSource);
  return (topic) => ControlledEventSource.instances.filter((s) => !s.closed && s.topics.includes(topic)).at(-1);
}
