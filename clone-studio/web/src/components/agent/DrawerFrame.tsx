import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

/** 默认宽度，也是最窄：§A.5「≤360 不允许」，420 时参数摘要截断 */
const MIN = 420;
/** 视口 ≥1600 才许拖宽到 640（Design-Brief §8.3）；1280-1599 固定 420 */
const WIDE_VIEWPORT = 1600;
const WIDE_MAX = 640;
/** 键盘调宽一步 */
const KEY_STEP = 20;

function maxWidth(): number {
  return window.innerWidth >= WIDE_VIEWPORT ? WIDE_MAX : MIN;
}

/**
 * 右侧抽屉的容器（SCREEN-001 第 3 条）：可收起；视口够宽时可拖宽（鼠标或键盘左右键）。
 * 开合由外面决定——有没有任务只有里面的内容知道。
 *
 * 收起时内容照样挂着（只是藏起来）：卸掉再挂回来，已经流完的回复会重新逐字打一遍，
 * 展开过的工具行、滚动位置也全丢（复审 S2-M1）。
 */
export function DrawerFrame({
  open,
  onOpenChange,
  header,
  railBadge,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  header: ReactNode;
  /** 收起时竖条上的状态提示：任务在跑时收着也看得见 */
  railBadge?: ReactNode;
  children: ReactNode;
}) {
  const [preferred, setPreferred] = useState(MIN);
  const [max, setMax] = useState(maxWidth);
  const dragging = useRef(false);
  const width = Math.min(max, Math.max(MIN, preferred));
  const resizable = max > MIN;

  useEffect(() => {
    const onResize = (): void => setMax(maxWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault(); // 拖的时候别顺手选中一片文字
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (dragging.current) setPreferred(window.innerWidth - e.clientX);
    };
    const stop = (): void => {
      dragging.current = false;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // 分隔条在抽屉左边：往左拉 = 变宽
    if (e.key === "ArrowLeft") setPreferred(width + KEY_STEP);
    else if (e.key === "ArrowRight") setPreferred(width - KEY_STEP);
    else return;
    e.preventDefault();
  };

  return (
    <>
      {open ? null : (
        <div className="flex shrink-0 flex-col border-l border-border bg-drawer p-2">
          <button
            type="button"
            aria-label="展开 Agent 过程抽屉"
            title="Agent 过程"
            onClick={() => onOpenChange(true)}
            className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-raised hover:text-text"
          >
            <PanelRightOpen aria-hidden className="size-4" />
          </button>
          {railBadge ? <div className="mt-2 flex justify-center">{railBadge}</div> : null}
        </div>
      )}
      {/* 能拖宽时在抽屉左边让出 14px：28px 的拖动区压在边框正中，左半落在这条空隙里，
          不会盖住旁边页面的滚动条（复审 S1-R3-1），右半只压在抽屉自己的内边距上 */}
      {open && resizable ? <div aria-hidden data-testid="drawer-gutter" className="w-3.5 shrink-0" /> : null}
      <aside
        aria-label="Agent 过程"
        hidden={!open}
        style={{ width }}
        className="relative flex shrink-0 flex-col border-l border-border bg-drawer font-mono text-[13px] leading-[1.55]"
      >
        {resizable ? (
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="拖动调整抽屉宽度"
            aria-valuemin={MIN}
            aria-valuemax={max}
            aria-valuenow={width}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            // 点击区 28px（Design-Brief §5.3 最小点击区），居中压在边框上；看得见的只有中间 4px 那条
            className="group absolute top-0 -left-3.5 z-10 flex h-full w-7 cursor-col-resize justify-center focus-visible:outline-none"
          >
            <span aria-hidden className="h-full w-1 group-hover:bg-primary/40 group-focus-visible:bg-primary/60" />
          </div>
        ) : null}
        <div className="flex min-h-[var(--shell-topbar-height)] items-start gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1">{header}</div>
          <button
            type="button"
            aria-label="收起 Agent 过程抽屉"
            onClick={() => onOpenChange(false)}
            className="shrink-0 rounded-md p-1.5 text-text-tertiary hover:bg-surface-raised hover:text-text"
          >
            <PanelRightClose aria-hidden className="size-4" />
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}
