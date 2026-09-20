import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

const MIN = 320;
const MAX = 640;
const DEFAULT = 420;

/**
 * 右侧 Agent 过程抽屉的容器（SCREEN-001 第 3 条）。
 * Phase 1 只做外壳：可收起、可拖宽 320-640px。里面的消息流是 Phase 5 的事。
 */
export function AgentDrawer({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(DEFAULT);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (!dragging.current) return;
      const next = window.innerWidth - e.clientX;
      setWidth(Math.min(MAX, Math.max(MIN, next)));
    };
    const up = (): void => {
      dragging.current = false;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  if (!open) {
    return (
      <div className="flex shrink-0 flex-col border-l border-border bg-surface p-2">
        <button
          type="button"
          aria-label="展开 Agent 过程抽屉"
          title="Agent 过程"
          onClick={() => setOpen(true)}
          className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-raised hover:text-text"
        >
          <PanelRightOpen aria-hidden className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <aside
      aria-label="Agent 过程"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-border bg-surface"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整抽屉宽度"
        onPointerDown={onPointerDown}
        className="absolute top-0 left-0 h-full w-1 cursor-col-resize hover:bg-primary/40"
      />
      <div className="flex h-[var(--shell-topbar-height)] items-center justify-between border-b border-border px-3">
        <span className="text-heading-md">Agent 过程</span>
        <button
          type="button"
          aria-label="收起 Agent 过程抽屉"
          onClick={() => setOpen(false)}
          className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-raised hover:text-text"
        >
          <PanelRightClose aria-hidden className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {children ?? <p className="text-caption text-text-tertiary">还没有运行中的任务。</p>}
      </div>
    </aside>
  );
}
