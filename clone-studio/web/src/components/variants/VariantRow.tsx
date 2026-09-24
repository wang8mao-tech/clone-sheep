import { nextActions } from "../../lib/agent-status.js";
import { formatUsd } from "../../lib/format.js";
import { formatRunElapsed } from "../../lib/run-elapsed.js";
import {
  buildFailed,
  CANCELLABLE,
  spentOf,
  stopReason,
  STOPPED,
  type VariantStatus,
  type VariantView,
} from "../../lib/variants.js";
import { TaskRow } from "../TaskRow.js";
import { Button } from "../ui/Button.js";
import { StatusMark } from "../ui/StatusMark.js";

export type RowAction = "retryBuild" | "rerun" | "continue" | "cancel";

interface Props {
  variant: VariantView;
  now: number;
  /** 点开素材审核面板（SCREEN-007）的地址；不给就整行不可点 */
  href?: string;
  busy: RowAction | null;
  /** 取消与重跑由队列先弹二次确认（Design-Brief §6.1），这里只报「要做什么」 */
  onAction: (action: RowAction) => void;
}

/** 服务端能重跑的变体状态（server/src/services/variant-review.ts RERUNNABLE） */
const RERUNNABLE: ReadonlySet<VariantStatus> = new Set(["failed", "tripped", "interrupted", "asset_review"]);

/**
 * 已经交给估价与出片（素材通过过）：服务端只在有运行文件时才给 estimate / build，
 * 这时 Agent 那一段已经结束，「继续」一定被拒（8.3 审查 HIGH-1）
 */
function inPipeline(v: VariantView): boolean {
  return v.estimate !== null || v.build !== null;
}

/**
 * ④ 变体队列的一行（CMP-002）：状态、名称、模型、Agent 用时、估价、花费（估）、行尾动作。
 * 要人动手的行（素材待审、待确认花费）左侧 2px 竖线：待审强调色、待确认琥珀（SCREEN-006）
 */
export function VariantRow({ variant: v, now, href, busy, onAction }: Props) {
  const failedBuild = buildFailed(v);
  // 继续只对 Agent 那一段：还没交给出片、任务本身还能 resume（已取消的任务没有会话，只能重跑）
  const canContinue =
    STOPPED.has(v.status) && !inPipeline(v) && v.agent !== null && nextActions(v.agent.status).includes("continue");
  const canRerun = RERUNNABLE.has(v.status);
  const accent = v.status === "asset_review" ? "primary" : v.status === "awaiting_cost_confirm" ? "warning" : "none";

  return (
    <TaskRow
      accent={accent}
      lead={
        <span className="inline-block w-[112px]">
          <StatusMark status={v.status} />
        </span>
      }
      title={v.name ?? v.brief ?? v.id}
      {...(href ? { href, openLabel: `打开变体 ${v.name ?? v.id}` } : {})}
      errorDetail={stopReason(v)?.text}
      columns={[
        { label: "模型", content: v.agent?.modelId ?? "订阅默认", width: "128px" },
        { label: "Agent 用时", content: v.agent ? formatRunElapsed(v.agent, now) : "—", width: "56px", numeric: true },
        {
          label: "估价",
          content: v.estimate?.totalUsd != null ? formatUsd(v.estimate.totalUsd) : "—",
          width: "64px",
          numeric: true,
        },
        { label: "花费", content: `${formatUsd(spentOf(v))} 估`, width: "72px", numeric: true },
      ]}
      actions={
        <div className="flex w-[232px] items-center justify-end gap-1">
          {failedBuild ? (
            <Button variant="ghost" loading={busy === "retryBuild"} onClick={() => onAction("retryBuild")}>
              重试出片
            </Button>
          ) : null}
          {canContinue ? (
            <Button variant="ghost" loading={busy === "continue"} onClick={() => onAction("continue")}>
              继续
            </Button>
          ) : null}
          {canRerun ? (
            <Button variant="ghost" loading={busy === "rerun"} onClick={() => onAction("rerun")}>
              重跑
            </Button>
          ) : null}
          {CANCELLABLE.has(v.status) ? (
            <Button variant="ghost" loading={busy === "cancel"} onClick={() => onAction("cancel")}>
              取消
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
