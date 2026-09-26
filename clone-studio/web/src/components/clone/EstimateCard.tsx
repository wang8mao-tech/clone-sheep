import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "../ui/Badge.js";
import { CloneCard as Card } from "./CloneCard.js";
import { Button } from "../ui/Button.js";
import { ApiError } from "../../lib/api.js";
import {
  capabilityLabel,
  estimateApi,
  estimateKeys,
  GATE_REASON_TEXT,
  type EstimateLine,
  type EstimateRecord,
} from "../../lib/estimate.js";
import { formatUsd } from "../../lib/format.js";

/**
 * CMP-006 估价 / 限额卡（设计稿「② 复刻」右栏）：估价金额大号等宽；请求明细；单条限额（有批次时再加批次）细进度条，
 * 超限部分琥珀；底部一行「限额内，将自动出片」或主按钮「确认出片 $x.xx」（Design-Brief §6.1 花钱按钮必带金额）。
 * 估价拿不到 / 未解析请求：说清卡在什么、要人做什么（§6.2）。
 */
export function EstimateCard({
  productionId,
  perItemLimitUsd,
  batchLimitUsd,
  batchSpentUsd,
}: {
  productionId: string;
  perItemLimitUsd: number;
  /** 属于批次时才有（复刻片没有） */
  batchLimitUsd?: number;
  batchSpentUsd?: number;
}) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: estimateKeys.production(productionId),
    queryFn: () => estimateApi.get(productionId),
    retry: false,
    // 还没估出来时后端 404：估价在跑，几秒后再看
    refetchInterval: (q) => (q.state.error instanceof ApiError && q.state.error.status === 404 ? 3_000 : false),
  });
  const refresh = (res: { estimate: EstimateRecord }): void => {
    qc.setQueryData(estimateKeys.production(productionId), res);
  };
  const confirm = useMutation({ mutationFn: () => estimateApi.confirm(productionId), onSuccess: refresh });
  const reestimate = useMutation({ mutationFn: () => estimateApi.reestimate(productionId), onSuccess: refresh });

  const error = query.error;
  const pending = error instanceof ApiError && error.status === 404;
  if (error && !pending) {
    return (
      <Card title="出片估价">
        <p className="text-caption text-danger">读不到估价：{error instanceof Error ? error.message : String(error)}</p>
        <Button variant="secondary" loading={query.isFetching} onClick={() => void query.refetch()}>
          重试
        </Button>
      </Card>
    );
  }
  if (!query.data) {
    // 后端还没有结论：估价在跑，几秒后再看。跑不起来的话这里会一直转，所以给「重新估价」当出口
    return (
      <Card title="出片估价">
        <p className="text-caption text-text-secondary">正在估价（hypit plan）…</p>
        <Button
          variant="ghost"
          className="self-start"
          loading={reestimate.isPending}
          onClick={() => reestimate.mutate()}
        >
          重新估价
        </Button>
        {reestimate.error ? (
          <p role="alert" className="text-caption text-danger">
            {reestimate.error instanceof Error ? reestimate.error.message : String(reestimate.error)}
          </p>
        ) : null}
      </Card>
    );
  }

  const est = query.data.estimate;
  const busy = confirm.isPending || reestimate.isPending;
  const actionError = confirm.error ?? reestimate.error;
  const badge =
    est.decision === "auto" ? (
      <Badge tone="success">限额内</Badge>
    ) : est.decision === "confirm" ? (
      <Badge tone="warning">{est.confirmedAt ? "已确认" : "待确认"}</Badge>
    ) : (
      <Badge tone="danger">不能出片</Badge>
    );

  return (
    <Card title="出片估价" badge={badge}>
      <span className="font-mono text-[28px] leading-none font-medium text-text tabular-nums">
        {est.totalUsd === null ? "—" : formatUsd(est.totalUsd)}
      </span>
      {est.kind === "blocked" ? (
        <p className="text-caption text-danger">{est.reason}</p>
      ) : (
        <LineItems lines={est.lines} error={est.error} />
      )}
      {est.kind === "ok" ? (
        <LimitBar label={`单条限额 ${formatUsd(perItemLimitUsd)}`} value={est.totalUsd} limit={perItemLimitUsd} />
      ) : null}
      {est.kind === "ok" && batchLimitUsd !== undefined ? (
        <LimitBar
          label={`批次已花 ${formatUsd(batchSpentUsd ?? 0)} / ${formatUsd(batchLimitUsd)}`}
          value={(batchSpentUsd ?? 0) + (est.totalUsd ?? 0)}
          limit={batchLimitUsd}
        />
      ) : null}
      {est.reasons.length ? (
        <ul className="flex flex-col gap-0.5 text-caption text-warning">
          {est.reasons.map((r) => (
            <li key={r}>{GATE_REASON_TEXT[r]}</li>
          ))}
        </ul>
      ) : null}
      {est.pricingUrls.length ? (
        <p className="text-caption text-text-tertiary">
          价格页：
          {est.pricingUrls.map((url, i) => (
            <span key={url}>
              {i > 0 ? "、" : ""}
              <a href={url} target="_blank" rel="noreferrer noopener" className="underline">
                {hostOf(url)}
              </a>
            </span>
          ))}
          ，用来核对费率表是否过期
        </p>
      ) : null}
      {est.decision === "auto" ? (
        <p className="text-caption text-text-secondary">限额内，将自动出片</p>
      ) : est.decision === "confirm" && !est.confirmedAt ? (
        <Button variant="primary" loading={confirm.isPending} disabled={busy} onClick={() => confirm.mutate()}>
          确认出片 {est.totalUsd === null ? "（估价拿不到）" : formatUsd(est.totalUsd)}
        </Button>
      ) : est.decision === "confirm" ? (
        <p className="text-caption text-text-secondary">已确认，将出片</p>
      ) : null}
      <Button
        variant="ghost"
        className="self-start"
        loading={reestimate.isPending}
        disabled={busy}
        onClick={() => reestimate.mutate()}
      >
        重新估价
      </Button>
      {actionError ? (
        <p role="alert" className="text-caption text-danger">
          {actionError instanceof Error ? actionError.message : String(actionError)}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * 请求明细（CMP-006「折叠列表」）：本地零价的合成一行「本地渲染」（设计稿也是一行），
 * 超过 3 行折叠起来只显示前 3 行 + 展开
 */
function LineItems({ lines, error }: { lines: EstimateLine[]; error: string | null }) {
  const [open, setOpen] = useState(false);
  const local = lines.filter((l) => l.local && l.usd === 0);
  const rows: Array<{ key: string; label: string; title: string; usd: number | null }> = [
    ...lines
      .filter((l) => !(l.local && l.usd === 0))
      .map((l) => ({
        key: `${l.endpoint ?? ""} ${l.capability}`,
        label: `${capabilityLabel(l.capability)} ×${l.count}`,
        title: l.capability,
        usd: l.usd,
      })),
    ...(local.length
      ? [{ key: "local", label: "本地渲染 / ffmpeg", title: local.map((l) => l.capability).join("\n"), usd: 0 }]
      : []),
  ];
  const shown = open ? rows : rows.slice(0, 3);
  return (
    <ul className="flex flex-col gap-1.5" aria-label="请求明细">
      {shown.map((row) => (
        <li key={row.key} className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-caption text-text-secondary" title={row.title}>
            {row.label}
          </span>
          <span className="font-mono text-caption text-text tabular-nums">
            {row.usd === null ? "拿不到" : formatUsd(row.usd)}
          </span>
        </li>
      ))}
      {rows.length > 3 ? (
        <li>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="text-caption text-text-tertiary hover:underline"
          >
            {open ? "收起" : `展开全部 ${rows.length} 项`}
          </button>
        </li>
      ) : null}
      {error ? <li className="text-caption text-danger">plan 没跑起来：{firstLine(error)}</li> : null}
    </ul>
  );
}

/** 细进度条（4px，圆角 2）：限额内那段强调色，超出限额的那段琥珀；拿不到时整条琥珀 */
function LimitBar({ label, value, limit }: { label: string; value: number | null; limit: number }) {
  const unknown = value === null || limit <= 0;
  const within = unknown ? 1 : Math.min(value, limit) / limit;
  const over = unknown ? 0 : Math.max(value - limit, 0) / Math.max(value, limit);
  // 超限时整条按 value 为 100%：限额内的部分占 limit/value，超出的占其余
  const withinWidth = unknown ? 100 : value > limit ? (limit / value) * 100 : within * 100;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-text-tertiary">{label}</span>
      <div className="flex h-1 w-full overflow-hidden rounded-[2px] bg-border">
        <div
          className={["h-1", unknown ? "bg-warning" : "bg-primary"].join(" ")}
          style={{ width: `${Math.round(withinWidth)}%` }}
        />
        {over > 0 ? <div className="h-1 bg-warning" style={{ width: `${Math.round(over * 100)}%` }} /> : null}
      </div>
    </div>
  );
}

/** 价格页链接只显示域名；Provider 给的 URL 坏了也不能让整张卡渲染崩掉 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}
