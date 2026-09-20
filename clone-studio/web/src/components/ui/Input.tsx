import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { useId } from "react";

const FIELD =
  "w-full rounded-md border bg-surface px-2 text-[13px] text-text placeholder:text-text-tertiary " +
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
    <div className="flex flex-col gap-1">
      {label ? (
        <label htmlFor={htmlFor} className="text-caption text-text-secondary">
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
        className={[FIELD, "h-8", mono ? "font-mono" : "", error ? "border-danger" : "border-border"].join(" ")}
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
        className={[FIELD, "py-1.5", mono ? "font-mono" : "", error ? "border-danger" : "border-border"].join(" ")}
      />
    </FieldShell>
  );
}
