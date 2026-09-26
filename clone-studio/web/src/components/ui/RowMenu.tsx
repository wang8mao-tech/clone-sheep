import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
}

interface Props {
  /** 无障碍名，如「足球榜 的操作」 */
  label: string;
  items: readonly RowMenuItem[];
}

/**
 * 行尾「…」菜单（SCREEN-001：悬停行尾出现「…」，重命名 / 删除）。
 *
 * 平时靠父行的 group-hover 显形，但获得焦点时必须照样可见，否则键盘用户
 * Tab 到它就等于按在空气上。所以 opacity 同时受 group-hover 与 focus 控制。
 */
export function RowMenu({ label, items }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  /** 关菜单时把焦点交还触发按钮——菜单项一 unmount 焦点会掉回 body，键盘用户就丢了位置 */
  const close = (restoreFocus = true): void => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    first.current?.focus();

    const onPointerDown = (e: PointerEvent): void => {
      // 点到别处关掉，但别把焦点抢回按钮——用户的意图是去点别的东西
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    // Tab 移出菜单也要关，否则会留下一个跟焦点脱节的浮层
    const onFocusIn = (e: FocusEvent): void => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          // 行本身是链接或折叠按钮，别让点菜单顺带触发它
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={[
          "flex size-5 items-center justify-center rounded text-text-tertiary transition-colors",
          "hover:bg-border hover:text-text focus-visible:opacity-100",
          open ? "bg-border text-text opacity-100" : "opacity-0 group-hover:opacity-100",
        ].join(" ")}
      >
        <MoreHorizontal aria-hidden className="size-3.5" />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className="elevation-overlay absolute top-full right-0 z-20 mt-1 flex w-28 flex-col rounded-md border border-border bg-surface py-1"
        >
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={i === 0 ? first : undefined}
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // 不交还焦点：接下来是就地改名的输入框或删除弹窗要抢焦点
                close(false);
                item.onSelect();
              }}
              className={[
                "px-3 py-1.5 text-left text-[13px] transition-colors",
                item.tone === "danger"
                  ? "text-danger hover:bg-danger/10"
                  : "text-text-secondary hover:bg-surface-raised hover:text-text",
              ].join(" ")}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
