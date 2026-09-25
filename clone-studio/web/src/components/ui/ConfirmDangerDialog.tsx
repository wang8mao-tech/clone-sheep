import { useEffect, useRef, useState } from "react";
import { Button } from "./Button.js";
import { Input } from "./Input.js";

interface Props {
  open: boolean;
  title: string;
  /** 要求用户逐字输入的名称，输对了才允许确认 */
  confirmName: string;
  /** 级联影响：删掉什么、中止多少任务（CMP-012） */
  impacts: readonly string[];
  confirmLabel?: string;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * CMP-012 危险确认弹窗：列出级联影响与将中止的任务数，需输入名称，确认按钮红色。
 * 用原生 <dialog>，焦点陷阱与 Esc 关闭由浏览器负责，不自己实现。
 */
export function ConfirmDangerDialog({
  open,
  title,
  confirmName,
  impacts,
  confirmLabel = "删除",
  busy = false,
  error,
  onConfirm,
  onCancel,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      setTyped("");
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  const matched = typed.trim() === confirmName;

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="elevation-overlay m-auto w-[420px] rounded-lg border border-border bg-surface p-0 text-text backdrop:bg-black/60"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (matched && !busy) onConfirm();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <h2 className="text-heading-md">{title}</h2>

        <ul className="flex flex-col gap-1 rounded-md border border-border bg-bg p-3">
          {impacts.map((line) => (
            <li key={line} className="text-[13px] text-text-secondary">
              {line}
            </li>
          ))}
        </ul>

        <Input
          label={`输入「${confirmName}」以确认`}
          value={typed}
          autoComplete="off"
          onChange={(e) => setTyped(e.target.value)}
          error={error}
        />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            variant="danger"
            type="submit"
            loading={busy}
            disabled={!matched}
            disabledReason={matched ? undefined : "名称不一致"}
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
