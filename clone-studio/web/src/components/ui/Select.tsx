import type { SelectHTMLAttributes } from "react";
import { useId } from "react";
import { ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  /** 小字副标题，用于显示模型 id 一类（CMP-010） */
  detail?: string;
  disabled?: boolean;
  /** 置灰原因，鼠标悬停可见 */
  disabledReason?: string;
}

interface Props extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "children"> {
  label?: string;
  hint?: string;
  error?: string;
  options: readonly SelectOption[];
}

export function Select({ label, hint, error, options, id, ...rest }: Props) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={fieldId} className="text-caption font-medium text-text-secondary">
          {label}
        </label>
      ) : null}
      <div className="relative">
        <select
          id={fieldId}
          {...rest}
          aria-invalid={error ? true : undefined}
          className={[
            "h-8 w-full appearance-none rounded-md border bg-bg pr-7 pl-2.5 text-[13px] text-text",
            "transition-colors hover:bg-surface-raised disabled:pointer-events-none disabled:opacity-40",
            error ? "border-danger" : "border-border",
          ].join(" ")}
        >
          {options.map((opt) => (
            <option
              key={opt.value}
              value={opt.value}
              disabled={opt.disabled}
              title={opt.disabled ? opt.disabledReason : undefined}
            >
              {opt.detail ? `${opt.label} · ${opt.detail}` : opt.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-text-tertiary"
        />
      </div>
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
