import { useEffect, useRef, useState } from "react";
import { useToast } from "../../components/ui/Toast.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router";
import { AssetReviewPanel } from "../../components/variants/AssetReviewPanel.js";
import { VariantQueue } from "../../components/variants/VariantQueue.js";
import { SubmitPanel } from "../../components/variants/SubmitPanel.js";
import { QueryErrorState } from "../../components/ui/QueryErrorState.js";
import { useTemplateAgent } from "../../lib/agent-feed-context.js";
import { agentApi } from "../../lib/agent.js";
import { api } from "../../lib/api.js";
import { archiveKeys, archiveApi } from "../../lib/archive.js";
import { buildApi } from "../../lib/build.js";
import type { Settings } from "../../lib/types.js";
import { useNow } from "../../lib/useNow.js";
import {
  BATCH_MAX,
  batchFinished,
  finishSummary,
  RUNNING,
  variantApi,
  variantKeys,
  type SubmitInput,
  type VariantView,
} from "../../lib/variants.js";
import type { RowAction } from "../../components/variants/VariantRow.js";

/** 有变体自己会变（RUNNING）时每 3 秒重拉一次：变体的任务事件推在它自己的主题上，模板页收不到用时与花费的变化 */
const POLL_MS = 3_000;

/** ④ 变体（SCREEN-006、REQ-005）：上部提交区、下部按批次分组的队列 */
export function VariantsStep() {
  const { templateId = "" } = useParams();
  return (
    <section aria-label="④ 变体 工作区" className="flex flex-col gap-4">
      <VariantsBody key={templateId} templateId={templateId} />
    </section>
  );
}

function VariantsBody({ templateId }: { templateId: string }) {
  const qc = useQueryClient();
  const { feed } = useTemplateAgent();
  const template = useQuery({
    queryKey: archiveKeys.template(templateId),
    queryFn: () => archiveApi.template(templateId),
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });
  const list = useQuery({
    queryKey: variantKeys.list(templateId),
    queryFn: () => variantApi.list(templateId),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.batches.some((b) => b.variants.some((v) => RUNNING.has(v.status))) ? POLL_MS : false,
  });
  const moving = list.data?.batches.some((b) => b.variants.some((v) => RUNNING.has(v.status))) ?? false;
  const now = useNow(moving);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState<{ id: string; action: RowAction } | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const [params, setParams] = useSearchParams();
  const openVariant = params.get("variant");

  const refresh = (): void => void qc.invalidateQueries({ queryKey: variantKeys.list(templateId) });
  // 变体状态、估价、出片推在模板主题上：都让队列重拉
  useEffect(() => {
    if (!feed) return;
    const offs = (["variants", "estimate", "build"] as const).map((name) =>
      feed.onTemplateEvent(name, () => void qc.invalidateQueries({ queryKey: variantKeys.list(templateId) })),
    );
    return () => offs.forEach((off) => off());
  }, [feed, qc, templateId]);

  // 批量全部结束时一条 toast（Design-Brief §6.2：「3 条完成，1 条失败」）。只报这次打开页面后才结束的批次，
  // 已经结束的老批次不报：第一次拿到数据时只记下状态
  const toast = useToast();
  const finished = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    const batches = list.data?.batches;
    if (!batches) return;
    const seen = finished.current;
    const next = new Map(batches.map((b) => [b.id, batchFinished(b)]));
    if (seen) {
      for (const b of batches) {
        if (next.get(b.id) && seen.get(b.id) === false) toast.push("info", finishSummary(b));
      }
    }
    finished.current = next;
  }, [list.data, toast]);

  const submit = async (input: SubmitInput): Promise<void> => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await variantApi.submit(templateId, input);
      setFormKey((k) => k + 1);
      refresh();
    } catch (error) {
      setSubmitError(error as Error);
    } finally {
      setSubmitting(false);
    }
  };

  const act = async (variant: VariantView, action: RowAction): Promise<void> => {
    setBusy({ id: variant.id, action });
    setActionError(null);
    try {
      if (action === "cancel") await variantApi.cancel(variant.id);
      else if (action === "rerun") await variantApi.rerun(variant.id);
      else if (action === "retryBuild") await buildApi.retry(variant.id);
      else if (variant.agent) await agentApi.continue(variant.agent.id);
    } catch (error) {
      const verb = { cancel: "取消", rerun: "重跑", retryBuild: "重试出片", continue: "继续" }[action];
      setActionError({
        id: variant.id,
        message: `「${variant.name ?? variant.id}」${verb}没成功：${(error as Error).message}`,
      });
    } finally {
      setBusy(null);
      refresh();
    }
  };

  if (list.isPending) return <p className="text-caption text-text-secondary">读取变体队列…</p>;
  if (list.error) {
    return (
      <QueryErrorState
        error={list.error}
        goneText="这个模板已经不存在了"
        errorText="读不到变体队列"
        retrying={list.isFetching}
        onRetry={() => void list.refetch()}
      />
    );
  }
  const batches = list.data.batches;
  // 返回队列：只去掉 variant 参数；焦点回到点开它的那一行（它一直挂着，只是藏起来了）
  const closePanel = (): void => {
    const id = openVariant;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("variant");
      return next;
    });
    if (id) {
      requestAnimationFrame(() =>
        // 那一行可能已经被当前筛选滤掉：退到队列本身
        (
          document.querySelector<HTMLElement>(`a[href$="variant=${encodeURIComponent(id)}"]`) ??
          document.querySelector<HTMLElement>('[aria-label="变体队列"]')
        )?.focus(),
      );
    }
  };
  const perItem = settings.data?.perItemLimitUsd ?? 1.5;

  // 点开一条：素材审核全幅面板覆盖工作区（SCREEN-007），步骤条与侧栏保留。队列与提交区只是藏起来不卸载：
  // 没提交的 brief 草稿、筛选都还在（8.4 第二轮审查 S2-M-A）
  return (
    <>
      {openVariant ? <AssetReviewPanel templateId={templateId} variantId={openVariant} onClose={closePanel} /> : null}
      <div hidden={openVariant !== null} className="flex flex-col gap-4">
        <SubmitPanel
          key={formKey}
          templateLanguage={template.data?.language ?? null}
          defaultBudgetUsd={settings.data?.batchLimitUsd ?? 15}
          perItemLimitUsd={perItem}
          // 与服务端一致：设置只能往小调，封顶 20（REQ-005 / FLOW-003；8.3 审查 MEDIUM-2）
          maxItems={Math.min(settings.data?.batchMaxItems || BATCH_MAX, BATCH_MAX)}
          busy={submitting}
          error={submitError}
          onSubmit={(input) => void submit(input)}
          defaultOpen={batches.length === 0}
        />
        {batches.length === 0 ? (
          <p className="text-caption text-text-secondary">
            还没有变体。在上面写几条 brief 提交，变体会按批次排在这里。
          </p>
        ) : (
          <VariantQueue
            batches={batches}
            now={now}
            hrefFor={(id) => `?variant=${encodeURIComponent(id)}`}
            busy={busy}
            error={actionError}
            onAction={(variant, action) => void act(variant, action)}
          />
        )}
      </div>
    </>
  );
}
