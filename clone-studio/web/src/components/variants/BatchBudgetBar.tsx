import { formatUsd } from "../../lib/format.js";

interface Props {
  spentUsd: number;
  limitUsd: number;
  /** 行内的前缀说明，如「批次限额」 */
  label?: string;
}

/**
 * CMP-006 的迷你版：一条细进度条 + 「已花 / 限额」等宽数字，超限部分琥珀（Design-Brief CMP-006）。
 * 提交区与批次组头共用：组头的数字就是闸门看的数字（服务端 batchBudget）
 */
export function BatchBudgetBar({ spentUsd, limitUsd, label = "批次" }: Props) {
  const ratio = limitUsd > 0 ? spentUsd / limitUsd : 0;
  const within = Math.min(ratio, 1);
  const over = ratio > 1;
  return (
    <div className="flex min-w-[180px] items-center gap-2">
      <span className="text-caption text-text-secondary">{label}</span>
      <div
        role="meter"
        aria-label={`${label}已花 ${formatUsd(spentUsd)}，限额 ${formatUsd(limitUsd)}`}
        aria-valuemin={0}
        aria-valuemax={limitUsd}
        aria-valuenow={spentUsd}
        className="relative h-1 flex-1 overflow-hidden rounded-full bg-surface-raised"
      >
        <div
          className={["absolute inset-y-0 left-0", over || within >= 1 ? "bg-warning" : "bg-primary"].join(" ")}
          style={{ width: `${within * 100}%` }}
        />
      </div>
      <span className={["font-mono text-caption", over ? "text-warning" : "text-text-secondary"].join(" ")}>
        {formatUsd(spentUsd)} / {formatUsd(limitUsd)}
      </span>
    </div>
  );
}
