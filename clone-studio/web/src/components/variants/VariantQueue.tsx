import { useState } from "react";
import { formatActivityTime } from "../../lib/format.js";
import {
  batchName,
  FILTERS,
  matchesFilter,
  sortForQueue,
  type BatchView,
  type VariantFilter,
  type VariantView,
} from "../../lib/variants.js";
import { ConfirmDialog } from "../ui/ConfirmDialog.js";
import { BatchBudgetBar } from "./BatchBudgetBar.js";
import { VariantRow, type RowAction } from "./VariantRow.js";

interface Props {
  batches: readonly BatchView[];
  now: number;
  /** 行点开素材审核面板的地址；不给就行不可点 */
  hrefFor?: (variantId: string) => string;
  /** 正在做的动作：哪一条、什么动作 */
  busy: { id: string; action: RowAction } | null;
  onAction: (variant: VariantView, action: RowAction) => void;
  /** 最近一次动作的失败原文（哪一条、什么动作、原文） */
  error: { id: string; message: string } | null;
}

/**
 * SCREEN-006 下部队列：五个筛选、按批次分组（新批次在前），组头是批次备注、提交时间与批次花费条；
 * 批次限额用尽时组头琥珀提示。组内要人动手的行置顶。取消、重跑先二次确认（Design-Brief §6.1）
 */
export function VariantQueue({ batches, now, hrefFor, busy, onAction, error }: Props) {
  const [filter, setFilter] = useState<VariantFilter>("all");
  const [confirm, setConfirm] = useState<{ variant: VariantView; action: "cancel" | "rerun" } | null>(null);
  const all = batches.flatMap((b) => b.variants);
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, all.filter((v) => matchesFilter(v, f.key)).length]));

  const act = (variant: VariantView, action: RowAction): void => {
    if (action === "cancel" || action === "rerun") setConfirm({ variant, action });
    else onAction(variant, action);
  };
  const shown = batches
    .map((b) => ({ batch: b, variants: sortForQueue(b.variants.filter((v) => matchesFilter(v, filter))) }))
    .filter((g) => g.variants.length > 0);

  return (
    <section aria-label="变体队列" tabIndex={-1} className="flex flex-col gap-3 outline-none">
      <div role="group" aria-label="筛选" className="flex items-center gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={[
              "h-7 rounded-md px-2.5 text-[13px]",
              filter === f.key ? "bg-surface-raised text-text" : "text-text-secondary hover:text-text",
            ].join(" ")}
          >
            {f.label} <span className="font-mono text-caption text-text-tertiary">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error.message}
        </p>
      ) : null}

      {shown.length === 0 ? (
        <p className="text-caption text-text-secondary">这个筛选下没有变体。</p>
      ) : (
        shown.map(({ batch, variants }) => (
          <div key={batch.id} className="rounded-md border border-border">
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
              <span className="text-[13px] font-medium text-text">{batch.note ?? "批次"}</span>
              <span className="text-caption text-text-tertiary">
                {formatActivityTime(batch.createdAt, now)} · {batch.variants.length} 条
              </span>
              <div className="ml-auto">
                <BatchBudgetBar spentUsd={batch.spentUsd} limitUsd={batch.limitUsd} />
              </div>
              {batch.halted ? (
                <p role="status" className="w-full text-caption text-warning">
                  批次限额已用尽，剩余变体等你确认
                </p>
              ) : null}
            </div>
            {/* 列头：宽度与 VariantRow 的列一一对应（状态 112、模型 128、用时 56、估价 64、花费 72、动作 232） */}
            <div
              aria-hidden
              className="flex h-8 items-center gap-3 border-b border-border px-3 pl-[14px] text-caption text-text-tertiary"
            >
              <span className="w-[112px] shrink-0">状态</span>
              <span className="min-w-0 flex-1">变体</span>
              <span className="w-[128px] shrink-0">模型</span>
              <span className="w-[56px] shrink-0 text-right">用时</span>
              <span className="w-[64px] shrink-0 text-right">估价</span>
              <span className="w-[72px] shrink-0 text-right">花费</span>
              <span className="w-[232px] shrink-0" />
            </div>
            <ul aria-label={`批次 ${batch.note ? batchName(batch) : formatActivityTime(batch.createdAt, now)} 的变体`}>
              {variants.map((v) => (
                <VariantRow
                  key={v.id}
                  variant={v}
                  now={now}
                  {...(hrefFor ? { href: hrefFor(v.id) } : {})}
                  busy={busy?.id === v.id ? busy.action : null}
                  onAction={(action) => act(v, action)}
                />
              ))}
            </ul>
          </div>
        ))
      )}

      <ConfirmDialog
        open={confirm?.action === "cancel"}
        title={`取消变体「${confirm?.variant.name ?? ""}」`}
        consequences={[
          "在跑的 Agent 会话会停下，正在渲染的出片会让 hypit 取消",
          "这条变体作废，之后不能再继续或重跑",
          "已经提交给 hypit 的出片仍计入批次已花",
        ]}
        confirmLabel="取消这条变体"
        onConfirm={() => {
          if (confirm) onAction(confirm.variant, "cancel");
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.action === "rerun"}
        title={`重跑变体「${confirm?.variant.name ?? ""}」`}
        consequences={[
          "Agent 写的稿子、SOURCES.json 与它抓来的图会被清掉，你替换过的图保留",
          "按原 brief 与模型开一个新会话，会有新的 Agent 花费",
        ]}
        confirmLabel="重跑"
        onConfirm={() => {
          if (confirm) onAction(confirm.variant, "rerun");
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
