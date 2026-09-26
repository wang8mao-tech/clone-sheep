import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { useId } from "react";

/**
 * 字段底色用 bg（#0E0F11）而不是 surface：表单都放在 surface 卡片里，同色的话
 * 输入框只剩一圈边框看得出来（设计稿「设置」「① 参考」两屏字段底色都是 #0E0F11）
 */
const FIELD =
  "w-full rounded-md border bg-bg px-2.5 text-text placeholder:text-text-tertiary " +
  "transition-colors hover:bg-surface-raised disabled:pointer-events-none disabled:opacity-40";

interface FieldShellProps {
  label?: string;
  hint?: ReactNode;
  /** 有值即进入错误态：红边 + 下方原文（Design-Brief 组件七态） */
  error?: string;
  htmlFor: string;
  children: ReactNode;
}

function FieldShell({ label, hint, error, htmlFor, children }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={htmlFor} className="text-caption font-medium text-text-secondary">
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p role="alert" className="font-mono text-caption text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-caption text-text-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  label?: string;
  hint?: ReactNode;
  error?: string;
  mono?: boolean;
}

export function Input({ label, hint, error, mono = false, id, ...rest }: InputProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={fieldId}>
      <input
        id={fieldId}
        {...rest}
        aria-invalid={error ? true : undefined}
        className={[
          FIELD,
          "h-8",
          mono ? "font-mono text-[12px]" : "text-[13px]",
          error ? "border-danger" : "border-border",
        ].join(" ")}
      />
    </FieldShell>
  );
}

interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> {
  label?: string;
  hint?: ReactNode;
  error?: string;
  mono?: boolean;
}

export function Textarea({ label, hint, error, mono = false, id, rows = 4, ...rest }: TextareaProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={fieldId}>
      <textarea
        id={fieldId}
        rows={rows}
        {...rest}
        aria-invalid={error ? true : undefined}
        className={[
          FIELD,
          "py-1.5",
          mono ? "font-mono text-[12px]" : "text-[13px]",
          error ? "border-danger" : "border-border",
        ].join(" ")}
      />
    </FieldShell>
  );
}
