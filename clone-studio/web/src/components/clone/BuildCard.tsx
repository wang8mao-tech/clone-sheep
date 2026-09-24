import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { ConfirmDialog } from "../ui/ConfirmDialog.js";
import { CloneCard as Card } from "./CloneCard.js";
import { useState } from "react";
import { ApiError } from "../../lib/api.js";
import {
  activityLabel,
  buildApi,
  buildKeys,
  formatBytes,
  progressRatio,
  stageLabel,
  type BuildView,
} from "../../lib/build.js";
import { formatUsd } from "../../lib/format.js";
import { formatDuration } from "../../lib/run-elapsed.js";
import { useNow } from "../../lib/useNow.js";

/**
 * CMP-007 出片进度 + 出片结果 / 失败卡（Design-Brief §4、SCREEN-005 错误态）：
 * 渲染中：阶段文字 + 细进度条 + 已用时长 + 「取消」；失败：错误 code + failure 原文（完整）+「重试出片」+ 当时可用内存；
 * 完成：文件、估价（标「估」）、receipt 链接。
 */
export function BuildCard({ productionId }: { productionId: string }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: buildKeys.production(productionId),
    queryFn: () => buildApi.get(productionId),
    retry: false,
    refetchInterval: (q) => (q.state.data?.build.status === "running" ? 2_000 : false),
  });
  const refresh = (): void => void qc.invalidateQueries({ queryKey: buildKeys.production(productionId) });
  const cancel = useMutation({ mutationFn: () => buildApi.cancel(productionId), onSuccess: refresh });
  const retry = useMutation({ mutationFn: () => buildApi.retry(productionId), onSuccess: refresh });
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const error = query.error;
  if (error instanceof ApiError && error.status === 404) return null;
  if (error) {
    return (
      <Card title="出片">
        <p className="text-caption text-danger">读不到出片状态：{error.message}</p>
      </Card>
    );
  }
  if (!query.data) return null;
  const build = query.data.build;
  const actionError = cancel.error ?? retry.error;

  return (
    <Card title="出片" badge={badgeOf(build)} tone={build.status === "failed" ? "danger" : "default"}>
      {build.status === "running" ? (
        <Running build={build} onCancel={() => setConfirmingCancel(true)} busy={cancel.isPending} />
      ) : null}
      {build.status === "done" ? <Done build={build} /> : null}
      {build.status === "failed" || build.status === "cancelled" ? (
        <Failed build={build} onRetry={() => retry.mutate()} busy={retry.isPending} />
      ) : null}
      {actionError ? (
        <p role="alert" className="text-caption text-danger">
          {actionError instanceof Error ? actionError.message : String(actionError)}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmingCancel}
        title="取消这次出片？"
        consequences={["已经渲染的帧会作废，之后可以重试出片。"]}
        confirmLabel="取消出片"
        busy={cancel.isPending}
        onConfirm={() => {
          setConfirmingCancel(false);
          cancel.mutate();
        }}
        onCancel={() => setConfirmingCancel(false)}
      />
    </Card>
  );
}

function badgeOf(build: BuildView) {
  if (build.status === "running") return <Badge tone="primary">渲染中</Badge>;
  if (build.status === "done") return <Badge tone="success">已出片</Badge>;
  if (build.status === "cancelled") return <Badge tone="neutral">已取消</Badge>;
  return <Badge tone="danger">出片失败</Badge>;
}

function Running({ build, onCancel, busy }: { build: BuildView; onCancel: () => void; busy: boolean }) {
  const now = useNow(true);
  const elapsed = build.startedAt ? Math.max(0, now - Date.parse(build.startedAt)) : 0;
  const ratio = progressRatio(build.progress);
  const p = build.progress;
  return (
    <>
      <div role="status" className="flex items-center gap-2 text-caption text-text-secondary">
        <span className="text-text">{p ? stageLabel(p) : (activityLabel(build.activity) ?? "提交")}</span>
        {p?.unitsTotal ? (
          <span className="font-mono tabular-nums">
            {p.unitsDone}/{p.unitsTotal} 帧
          </span>
        ) : null}
        <span className="ml-auto font-mono tabular-nums">{formatDuration(elapsed)}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-[2px] bg-border">
        <div
          className={["h-1 bg-primary", ratio === null ? "w-1/3 animate-pulse" : ""].join(" ")}
          style={ratio === null ? undefined : { width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      {p ? (
        <p className="truncate font-mono text-[11px] text-text-tertiary" title={p.raw}>
          {p.raw}
        </p>
      ) : null}
      {/* Design-Brief §7.2：取消是次按钮，与「重试出片」同级 */}
      <Button variant="secondary" className="self-start" loading={busy} onClick={onCancel}>
        取消
      </Button>
    </>
  );
}

function Done({ build }: { build: BuildView }) {
  return (
    <>
      <p className="truncate font-mono text-[11px] text-text-secondary" title={build.outputPath ?? ""}>
        {build.outputPath?.split(/[\\/]/).pop() ?? "—"}
      </p>
      <div className="flex items-center gap-2 text-caption text-text-secondary">
        <span>花费</span>
        <span className="font-mono text-text tabular-nums">
          {build.estimateUsd === null ? "—" : formatUsd(build.estimateUsd)}
        </span>
        {/* REQ-009：build 没有实际金额，一律标「估」 */}
        <Badge tone="warning">估</Badge>
        {build.hypitBuildId ? (
          <span className="ml-auto truncate font-mono text-[11px] text-text-tertiary" title={build.hypitBuildId}>
            {build.hypitBuildId}
          </span>
        ) : null}
      </div>
      {build.receiptUrl && /^https?:\/\//.test(build.receiptUrl) ? (
        <a href={build.receiptUrl} target="_blank" rel="noreferrer noopener" className="text-caption underline">
          去 Provider 侧查看 receipt
        </a>
      ) : null}
      <p className="text-caption text-text-tertiary">验货时在 ③ 验货里和原片并排看。</p>
    </>
  );
}

function Failed({ build, onRetry, busy }: { build: BuildView; onRetry: () => void; busy: boolean }) {
  return (
    <>
      <p className="font-mono text-[11px] text-danger">{build.errorCode ?? "BUILD_FAILED"}</p>
      {build.errorMessage ? (
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-[11px] break-all whitespace-pre-wrap text-text-secondary">
          {build.errorMessage}
        </pre>
      ) : null}
      {build.context ? (
        <p className="text-[11px] text-text-tertiary">
          失败时可用内存 {formatBytes(build.context.freeMemBytes)} / {formatBytes(build.context.totalMemBytes)}
          {build.context.lastProgress ? ` · 最后进度：${build.context.lastProgress}` : ""}
        </p>
      ) : null}
      <Button variant="secondary" className="self-start" loading={busy} onClick={onRetry}>
        重试出片
      </Button>
    </>
  );
}
