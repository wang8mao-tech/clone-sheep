import { useEffect, useState } from "react";

/** 每一跳的间隔 */
const TICK_MS = 16;
/**
 * 一段文字最多流多久。Spec 要求消息产生到抽屉显示 ≤1 秒：落库、SSE、拉取、渲染已经占掉一截，
 * 最后一个字也得在 1 秒内出来，所以流动本身只给 0.6 秒（复审 S1-M6）
 */
const MAX_MS = 600;

/**
 * 逐字流式（Design-Brief §A.2）。后端的消息是整条落库的，逐字在这里做：只对打开抽屉之后
 * 才到的回复生效，历史消息直接整段显示。尊重 prefers-reduced-motion。
 *
 * 显示到第几个字按「开始流到现在过了多久」算，不按跳了几下算：标签页在后台时浏览器把定时器
 * 压到一秒一跳，按跳数走的话 0.6 秒的流会拖成半分钟（真机实测），按时间算则每一跳都追上进度。
 */
export function useTypewriter(text: string, animate: boolean): { shown: string; typing: boolean } {
  const [startedAt] = useState(() => (animate && !reducedMotion() ? Date.now() : null));
  const [count, setCount] = useState(() => (startedAt === null ? text.length : 0));

  useEffect(() => {
    if (startedAt === null || count >= text.length) return;
    const timer = setTimeout(() => {
      const progress = (Date.now() - startedAt) / MAX_MS;
      setCount(Math.min(text.length, Math.max(count + 1, Math.ceil(text.length * progress))));
    }, TICK_MS);
    return () => clearTimeout(timer);
  }, [count, startedAt, text.length]);

  return { shown: count >= text.length ? text : text.slice(0, count), typing: count < text.length };
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
