import { useEffect, useRef } from "react";
import { Button } from "./Button.js";

interface Props {
  open: boolean;
  title: string;
  /** 做了之后会发生什么，一条一行 */
  consequences: readonly string[];
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 普通二次确认（Design-Brief §6.1「取消任务、重跑走普通二次确认」）：写清后果，点确认才做。
 * 这类动作会清掉东西、撤不回来，确认按钮用红色。
 * 删除那种要逐字输入名称的是 CMP-012（ConfirmDangerDialog），这里不要求输入。
 * 同样用原生 <dialog>，焦点陷阱与 Esc 关闭由浏览器负责。
 */
export function ConfirmDialog({ open, title, consequences, confirmLabel, busy = false, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

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
          if (!busy) onConfirm();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <h2 className="text-heading-md">{title}</h2>
        <ul className="flex flex-col gap-1 rounded-md border border-border bg-bg p-3">
          {consequences.map((line) => (
            <li key={line} className="text-[13px] text-text-secondary">
              {line}
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" type="submit" loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
