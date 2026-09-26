import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "primary" | "warning" | "danger" | "success" | "info";

const TONE: Record<BadgeTone, string> = {
  neutral: "border-border text-text-secondary",
  primary: "border-primary/40 text-primary",
  warning: "border-warning/40 text-warning",
  danger: "border-danger/40 text-danger",
  success: "border-success/40 text-success",
  info: "border-info/40 text-info",
};

/** 徽标：能力标记、"估"标记、"未验证"标记等。不用 pill（Design-Brief 5.4）。 */
export function Badge({
  tone = "neutral",
  mono = false,
  children,
  title,
}: {
  tone?: BadgeTone;
  mono?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={[
        "inline-flex h-5 items-center rounded-sm border px-1.5 text-caption leading-none",
        mono ? "font-mono" : "",
        TONE[tone],
      ].join(" ")}
    >
      {children}
    </span>
  );
}
