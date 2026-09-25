import { useState } from "react";
import { CostUnknownBadge } from "../CostUnknownBadge.js";
import { formatUsd } from "../../lib/format.js";
import { formatClipSeconds, type OutputView } from "../../lib/outputs.js";
import { Badge } from "../ui/Badge.js";
import { InlineNameEditor } from "../ui/InlineNameEditor.js";
import { StatusMark, statusLabel, type StatusKind } from "../ui/StatusMark.js";

interface Props {
  output: OutputView;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  renaming: { busy: boolean; error?: string } | null;
  onRenameStart: () => void;
  onRename: (name: string) => void;
  onRenameCancel: () => void;
}

/** 在流水线里的原始状态：照 ④ 的叫法说清在哪一步（9.2 审查 S1-4） */
const PIPELINE: ReadonlySet<string> = new Set([
  "queued",
  "agent_running",
  "awaiting_quota",
  "asset_review",
  "awaiting_cost_confirm",
]);

/** 卡片的状态文字：完成 / 渲染中 N% / 流水线里的哪一步 / 失败 / 熔断 / 已被 vN 取代 */
function statusOf(o: OutputView): { kind: StatusKind; label?: string } {
  // 旧版复刻片：只说被取代，不画删除线、也不盖掉它本来的颜色（9.2 审查 S2-5）
  if (o.supersededBy !== null) return { kind: "queued", label: `已被 v${o.supersededBy} 取代` };
  if (o.status === "building") {
    // 同出片卡 CMP-007：按帧数算百分比，帧数还没报上来就只写「渲染中」
    const p = o.build?.progress;
    const pct = p?.unitsTotal ? Math.floor(((p.unitsDone ?? 0) / p.unitsTotal) * 100) : null;
    return { kind: "building", label: pct === null ? "渲染中" : `渲染中 ${pct}%` };
  }
  if (o.productionStatus === "tripped") return { kind: "tripped" };
  if (o.status === "pending") {
    return { kind: PIPELINE.has(o.productionStatus) ? (o.productionStatus as StatusKind) : "queued" };
  }
  return { kind: o.status };
}

/**
 * ⑤ 成片卡片（SCREEN-008）：竖屏封面（点开播放或看错误）、左上角多选框、名称（点一下就地改）+ 时长、状态 + 花费「估」。
 * 只有能下载的才能勾选（打包只收完成且文件在的）
 */
export function OutputCard({
  output: o,
  selected,
  onToggle,
  onOpen,
  renaming,
  onRenameStart,
  onRename,
  onRenameCancel,
}: Props) {
  const [coverFailed, setCoverFailed] = useState(false);
  const status = statusOf(o);
  const showCover = o.coverUrl !== null && !coverFailed;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="relative">
        <button
          type="button"
          onClick={onOpen}
          aria-label={o.status === "done" ? `播放 ${o.name}` : `查看 ${o.name}`}
          className={[
            "flex h-[280px] w-full items-center justify-center overflow-hidden rounded-md border border-border bg-surface",
            selected ? "outline-2 outline-offset-2 outline-primary" : "",
          ].join(" ")}
        >
          {showCover ? (
            <img
              src={o.coverUrl ?? undefined}
              alt=""
              className="h-full w-full object-contain"
              onError={() => setCoverFailed(true)}
            />
          ) : (
            <span className="font-mono text-[11px] text-text-tertiary">9:16</span>
          )}
        </button>
        <label
          className="absolute top-1.5 left-1.5 flex size-7 items-center justify-center rounded-sm bg-bg/80"
          title={o.downloadable ? undefined : "只有完成的成片能勾选下载"}
        >
          <input
            type="checkbox"
            checked={selected}
            disabled={!o.downloadable}
            onChange={onToggle}
            aria-label={`选择 ${o.name}`}
            className="size-3.5 accent-primary disabled:opacity-40"
          />
        </label>
      </div>

      {renaming ? (
        <InlineNameEditor
          initialValue={o.name}
          placeholder="成片名称"
          busy={renaming.busy}
          {...(renaming.error ? { error: renaming.error } : {})}
          indentClass="pl-0"
          onCommit={onRename}
          onCancel={onRenameCancel}
        />
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title="点一下改名"
            onClick={onRenameStart}
            className="min-w-0 flex-1 truncate rounded-sm text-left text-[12px] font-medium text-text hover:bg-surface-raised"
          >
            {o.name}
          </button>
          <span className="font-mono text-[11px] text-text-secondary tabular-nums">
            {formatClipSeconds(o.durationS)}
          </span>
        </div>
      )}
      {/* 窄卡片（抽屉展开 4 列）放不下：状态一行、花费换到下一行靠右，不把「已被 vN 取代」裁没（9.2 第四轮审查 S1-M3） */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px]">
        <span className="flex min-w-0 flex-auto" title={status.label ?? statusLabel(status.kind)}>
          <StatusMark status={status.kind} size="sm" {...(status.label ? { label: status.label } : {})} />
        </span>
        {/* 金额和「估」是一个整体：换行时一起换、靠右（9.2 第五轮审查 S1-M1）；REQ-009 MUST：两类花费一律标「估」 */}
        {/* 「含未知」在窄卡片（6 列刚过 700px、4 列窄于 500px）放不下时自己换到下一行，金额和「估」不拆（11.4 审查 S2-M2） */}
        <span className="ml-auto inline-flex max-w-full flex-wrap items-center justify-end gap-0.5">
          <span className="font-mono text-text tabular-nums">{formatUsd(o.costUsd)}</span>
          <Badge tone="warning" title="花费均为估算，以 Provider 侧为准">
            估
          </Badge>
          <CostUnknownBadge show={o.costHasUnknown} />
        </span>
      </div>
    </div>
  );
}
