import { Check, X } from "lucide-react";

/**
 * CMP-003 状态标记：色点 8px + 文字。
 * 状态不只靠颜色区分（Design-Brief 8.2）：完成带对勾、已取消带删除线、中断带斜纹。
 */
export type StatusKind =
  | "queued"
  | "agent_running"
  | "building"
  | "awaiting_quota"
  | "asset_review"
  | "awaiting_cost_confirm"
  | "done"
  | "failed"
  | "tripped"
  | "interrupted"
  | "cancelled";

interface Spec {
  label: string;
  dot: string;
  text: string;
  pulse?: boolean;
  /** 中断用灰斜纹，与纯灰的"排队"区分 */
  hatched?: boolean;
  icon?: "check" | "cross";
  strike?: boolean;
}

const SPEC: Record<StatusKind, Spec> = {
  queued: { label: "排队", dot: "bg-text-tertiary", text: "text-text-secondary" },
  agent_running: { label: "Agent 写稿中", dot: "bg-primary", text: "text-text", pulse: true },
  building: { label: "渲染中", dot: "bg-primary", text: "text-text", pulse: true },
  awaiting_quota: { label: "等待额度", dot: "bg-info", text: "text-info" },
  asset_review: { label: "待你审", dot: "bg-primary", text: "text-primary" },
  awaiting_cost_confirm: { label: "待确认花费", dot: "bg-warning", text: "text-warning" },
  done: { label: "完成", dot: "bg-success", text: "text-success", icon: "check" },
  failed: { label: "失败", dot: "bg-danger", text: "text-danger", icon: "cross" },
  tripped: { label: "已熔断", dot: "bg-danger", text: "text-danger", icon: "cross" },
  interrupted: { label: "中断", dot: "bg-text-tertiary", text: "text-text-secondary", hatched: true },
  cancelled: { label: "已取消", dot: "bg-text-tertiary", text: "text-text-tertiary", strike: true },
};

export function StatusMark({
  status,
  label,
  size = "md",
}: {
  status: StatusKind;
  label?: string;
  /** sm = 11px：⑤ 成片卡片下的状态行（设计稿 11px），其余照旧 13px */
  size?: "md" | "sm";
}) {
  const spec = SPEC[status];
  return (
    <span
      className={[
        "inline-flex items-center whitespace-nowrap",
        size === "sm" ? "max-w-full min-w-0 gap-1" : "gap-2",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "inline-block size-2 shrink-0 rounded-full",
          spec.dot,
          spec.pulse ? "animate-pulse" : "",
          spec.hatched ? "opacity-60 outline-1 outline-text-tertiary outline-dashed" : "",
        ].join(" ")}
      />
      <span
        className={[
          spec.text,
          // 小号用在窄卡片里：放不下就省略号，不硬裁（9.2 第三轮审查 S1-2）
          size === "sm" ? "min-w-0 truncate text-[11px]" : "text-[13px]",
          spec.strike ? "line-through" : "",
        ].join(" ")}
      >
        {label ?? spec.label}
      </span>
      {spec.icon === "check" ? (
        <Check aria-hidden className={`${size === "sm" ? "size-3" : "size-3.5"} text-success`} />
      ) : null}
      {spec.icon === "cross" ? (
        <X aria-hidden className={`${size === "sm" ? "size-3" : "size-3.5"} text-danger`} />
      ) : null}
    </span>
  );
}

export function statusLabel(status: StatusKind): string {
  return SPEC[status].label;
}
