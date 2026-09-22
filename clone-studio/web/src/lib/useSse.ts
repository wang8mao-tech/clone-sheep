import { useEffect, useRef } from "react";

export interface SseFrame {
  topic: string;
  data: unknown;
}

/**
 * 订阅后端事件流。
 *
 * 事件只当作"快照失效"的提示用：拿到事件就让对应的 query 失效重拉，
 * 不靠事件流在前端累积状态。断线重连后若补发窗口已滚掉，全量重拉也是对的。
 */
export function useSse(topics: readonly string[], onEvent: (event: string, frame: SseFrame) => void): void {
  const handler = useRef(onEvent);

  // 在 effect 里同步而不是直接在 render 里写 ref：render 期间改 ref 在并发渲染
  // 下不安全（渲染可能被丢弃或重放），react-hooks/refs 就是拦这个的。
  // 单独一个 effect、不带依赖数组，每次渲染后都把最新的回调放进去
  useEffect(() => {
    handler.current = onEvent;
  });

  const key = topics.join(",");

  useEffect(() => {
    if (!key) return;
    const source = new EventSource(`/api/events?topics=${encodeURIComponent(key)}`);

    const listener = (e: MessageEvent<string>): void => {
      try {
        handler.current(e.type, JSON.parse(e.data) as SseFrame);
      } catch {
        // 单条事件解析失败不该拖垮整条流
      }
    };

    source.onmessage = listener;
    for (const name of ["archive", "template", "evidence", "production", "job", "build", "settings"]) {
      source.addEventListener(name, listener as EventListener);
    }

    return () => source.close();
  }, [key]);
}
