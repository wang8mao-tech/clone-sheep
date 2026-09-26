import { useEffect, useState } from "react";

/** 秒级时钟：只在有东西要走表时跳，其余时候不白白重渲染 */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    // 开始走表那一刻先对一次：不对的话要用挂载时的旧时间撑一秒，「用时」「思考中」会先显示成 0
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [ticking]);
  return now;
}
