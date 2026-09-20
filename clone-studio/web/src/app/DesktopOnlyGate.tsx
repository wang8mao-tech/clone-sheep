import type { ReactNode } from "react";
import { useEffect, useState } from "react";

const MIN_WIDTH = 1280;
const QUERY = `(max-width: ${MIN_WIDTH - 1}px)`;

/**
 * Design-Brief 8.3：这是桌面工具，不做响应式适配。
 * 视口窄于 1280px 时直接换成一句提示，而不是把布局挤成没法用的样子。
 */
export function DesktopOnlyGate({ children }: { children: ReactNode }) {
  // 初始态与后续更新用同一个口径（matchMedia），不混用 innerWidth——
  // 两者在缩放或有滚动条时会给出不同答案，混用会让首帧和后续帧不一致。
  const [tooNarrow, setTooNarrow] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(QUERY);
    const update = (): void => setTooNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  if (tooNarrow) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <p className="text-[13px] text-text-secondary">请在桌面浏览器使用，窗口宽度至少 1280px。</p>
      </div>
    );
  }
  return <>{children}</>;
}
