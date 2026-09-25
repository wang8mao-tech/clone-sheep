import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary enabled:hover:bg-primary-soft",
  secondary: "bg-surface-raised text-text border border-border enabled:hover:bg-[#23262b]",
  ghost: "bg-transparent text-text-secondary enabled:hover:bg-surface-raised enabled:hover:text-text",
  danger: "bg-danger text-white enabled:hover:brightness-110",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  /** 禁用原因。按 Design-Brief 的七态要求，禁用必须说明为什么。 */
  disabledReason?: string;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  loading = false,
  disabledReason,
  icon,
  className = "",
  children,
  disabled,
  ...rest
}: Props) {
  const isDisabled = disabled || loading;
  return (
    <button
      type="button"
      {...rest}
      disabled={isDisabled}
      title={isDisabled && disabledReason ? disabledReason : rest.title}
      aria-disabled={isDisabled || undefined}
      className={[
        "inline-flex h-8 items-center justify-center gap-2 rounded-md px-3",
        "text-[13px] font-medium whitespace-nowrap transition-colors",
        // 禁用时不吞指针事件：悬停要能看到 title 里的禁用原因（Design-Brief 七态「禁用必须说明为什么」；
        // 原来的 pointer-events-none 让所有禁用原因的 tooltip 都弹不出来，8.4 审查 LOW / Task 9.3）。
        // 点击本来就不会触发（disabled），hover 样式只给可用的
        "disabled:cursor-not-allowed disabled:opacity-40",
        VARIANT[variant],
        className,
      ].join(" ")}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}
