import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useTemplateAgent } from "../../lib/agent-feed-context.js";
import { estimateKeys } from "../../lib/estimate.js";
import { scriptParagraphs, variantReviewApi, variantReviewKeys, type AssetView } from "../../lib/variant-review.js";
import { CANCELLABLE, stopReason, variantApi, variantKeys, type VariantView } from "../../lib/variants.js";
import { ReworkPanel } from "../../pages/steps/ReworkPanel.js";
import { BuildCard } from "../clone/BuildCard.js";
import { EstimateCard } from "../clone/EstimateCard.js";
import { Button } from "../ui/Button.js";
import { ConfirmDialog } from "../ui/ConfirmDialog.js";
import { QueryErrorState } from "../ui/QueryErrorState.js";
import { CloneCard } from "../clone/CloneCard.js";
import { StatusMark } from "../ui/StatusMark.js";
import { AssetCard } from "./AssetCard.js";
import { AssetLightbox } from "./AssetLightbox.js";

interface Props {
  templateId: string;
  variantId: string;
  onClose: () => void;
}

/**
 * 估价卡只在闸门之前（排队、待确认、估价没过又没出过片），过了闸门换出片卡——同 ② 复刻页的 showsEstimate / showsBuild。
 * 过了闸门还挂着估价卡的话，「确认出片」「重新估价」一定被服务端拒（8.4 第二轮审查 S1-M-A）
 */
function showsEstimate(v: VariantView): boolean {
  if (v.status === "awaiting_cost_confirm") return true;
  // 素材通过后在排队：估价在跑，卡片显示「正在估价」并给「重新估价」当出口（跑不起来时不至于只剩取消）
  if (v.status === "queued") return v.approved;
  return v.status === "failed" && v.approved && v.build === null;
}

function showsBuild(v: VariantView): boolean {
  if (!v.build) return false;
  return v.status === "building" || v.status === "done" || v.status === "interrupted" || v.status === "failed";
}

/**
 * SCREEN-007 素材审核全幅面板：覆盖工作区（步骤条与侧栏保留）。左 65% 素材网格 CMP-005，
 * 右 35% 上为台词全文（等宽、按段）、下为估价卡与动作区；底部一行版权提示。
 * 主操作「素材通过」（有缺口禁用并写明原因）；次要：替换单张、打回写意见（resume 该变体会话）、取消该变体。
 * 通过后估价在后台跑：限额内自动出片，超限估价卡里给「确认出片 $x.xx」（AC-018）
 */
export function AssetReviewPanel({ templateId, variantId, onClose }: Props) {
  const qc = useQueryClient();
  const { feed } = useTemplateAgent();
  const state = useQuery({
    queryKey: variantReviewKeys.state(variantId),
    queryFn: () => variantReviewApi.state(variantId),
    retry: false,
  });
  const [zoom, setZoom] = useState<AssetView | null>(null);
  // 正在替换的素材（可以几张一起换）：换完之前「素材通过」「打回」不可点，不然出片会用上旧图（8.4 审查 S1-M3）
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set());
  const [assetErrors, setAssetErrors] = useState<Record<string, string>>({});
  const [confirmCancel, setConfirmCancel] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: variantReviewKeys.state(variantId) });
    void qc.invalidateQueries({ queryKey: variantKeys.list(templateId) });
    void qc.invalidateQueries({ queryKey: estimateKeys.production(variantId) });
  };
  useEffect(() => {
    if (!feed) return;
    const offs = (["variants", "estimate", "build"] as const).map((name) =>
      feed.onTemplateEvent(name, () => void qc.invalidateQueries({ queryKey: variantReviewKeys.state(variantId) })),
    );
    return () => offs.forEach((off) => off());
  }, [feed, qc, variantId]);
  // 打开面板时焦点落到标题上：点开它的那一行被藏起来了，不移过来焦点会掉到 body
  const loaded = state.data !== undefined;
  useEffect(() => {
    if (loaded) heading.current?.focus();
  }, [loaded]);

  // 一个动作成功了，别的动作留下的旧错误就过时了：清掉（8.4 第二轮审查 L-a）
  const approve = useMutation({
    mutationFn: () => variantReviewApi.approve(variantId),
    onSuccess: () => {
      rework.reset();
      cancel.reset();
    },
    onSettled: refresh,
  });
  const rework = useMutation({
    mutationFn: (note: string) => variantReviewApi.rework(variantId, note),
    onSuccess: () => {
      approve.reset();
      cancel.reset();
    },
    onSettled: refresh,
  });
  const cancel = useMutation({
    mutationFn: () => variantApi.cancel(variantId),
    onSuccess: () => {
      approve.reset();
      rework.reset();
    },
    onSettled: refresh,
  });

  const replace = async (asset: AssetView, file: File): Promise<void> => {
    setReplacing((prev) => new Set(prev).add(asset.id));
    setAssetErrors(({ [asset.id]: _drop, ...rest }) => rest);
    try {
      await variantReviewApi.replace(asset.id, file);
    } catch (error) {
      setAssetErrors((prev) => ({ ...prev, [asset.id]: `没换成：${(error as Error).message}` }));
    } finally {
      setReplacing((prev) => {
        const next = new Set(prev);
        next.delete(asset.id);
        return next;
      });
      refresh();
    }
  };

  if (state.isPending) return <p className="text-caption text-text-secondary">读取素材…</p>;
  if (state.error) {
    return (
      <QueryErrorState
        error={state.error}
        goneText="这条变体已经不存在了"
        errorText="读不到这条变体的素材"
        retrying={state.isFetching}
        onRetry={() => void state.refetch()}
      />
    );
  }
  const data = state.data;
  const v = data.variant;
  const name = v.name ?? v.id;
  const reviewing = v.status === "asset_review";
  const busyReason = replacing.size > 0 ? "正在替换图片，换完再提交" : undefined;
  // 出片卡自己会写出片的错；估价卡挂着时它自己写估价没过的原因。别的停因（估价比出片新、Agent 写稿停下）在这里说（8.4 第四轮审查 S1-M-1）
  const stop = stopReason(v);
  const stopText = stop && stop.step !== "build" && !(stop.step === "estimate" && showsEstimate(v)) ? stop.text : null;
  const actionError = approve.error
    ? `素材没通过：${approve.error.message}`
    : rework.error
      ? `打回没提交：${rework.error.message}`
      : cancel.error
        ? `没取消成：${cancel.error.message}`
        : null;

  return (
    <section aria-label={`素材审核：${name}`} className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" icon={<ArrowLeft aria-hidden className="size-4" />} onClick={onClose}>
          返回队列
        </Button>
        <h2 ref={heading} tabIndex={-1} className="truncate text-heading-lg text-text outline-none">
          {name}
        </h2>
        <StatusMark status={v.status} />
        {CANCELLABLE.has(v.status) ? (
          <Button variant="ghost" className="ml-auto" loading={cancel.isPending} onClick={() => setConfirmCancel(true)}>
            取消该变体
          </Button>
        ) : null}
      </header>
      {v.brief ? <p className="text-caption text-text-secondary">Brief：{v.brief}</p> : null}

      <div className="flex gap-4">
        <div className="min-w-0 basis-[65%]">
          {data.assets.length === 0 ? (
            <p className="text-caption text-text-secondary">
              {reviewing ? "这条变体没有用到联网素材。" : "素材在 Agent 写完、宿主核过判据之后出现在这里。"}
            </p>
          ) : (
            <ul aria-label="素材" className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
              {data.assets.map((asset) => (
                <li key={asset.id}>
                  <AssetCard
                    asset={asset}
                    editable={reviewing && !approve.isPending}
                    busy={replacing.has(asset.id)}
                    error={assetErrors[asset.id] ?? null}
                    onReplace={(file) => void replace(asset, file)}
                    onZoom={() => setZoom(asset)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="flex min-w-0 basis-[35%] flex-col gap-3">
          <CloneCard title="台词全文">
            {data.script ? (
              <div className="flex max-h-[360px] flex-col gap-2 overflow-auto font-mono text-[12px] whitespace-pre-wrap text-text">
                {scriptParagraphs(data.script).map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
                {data.scriptTruncated ? <p className="text-text-tertiary">（太长，只显示前一部分）</p> : null}
              </div>
            ) : (
              <p className="text-caption text-text-tertiary">还没有台词全文（SCRIPT.md）。</p>
            )}
          </CloneCard>

          {showsEstimate(v) ? (
            <EstimateCard
              productionId={v.id}
              perItemLimitUsd={data.perItemLimitUsd}
              {...(data.batch ? { batchLimitUsd: data.batch.limitUsd, batchSpentUsd: data.batch.spentUsd } : {})}
            />
          ) : null}
          {stopText ? (
            <p aria-label="停下原因" className="font-mono text-caption whitespace-pre-wrap text-danger">
              {stopText}
            </p>
          ) : null}
          {showsBuild(v) ? <BuildCard productionId={v.id} /> : null}

          {actionError ? (
            <p role="alert" className="text-caption text-danger">
              {actionError}
            </p>
          ) : null}
          {reviewing ? (
            // 打回展开后占满一行，「素材通过」换到下一行靠右：35% 的侧栏放不下两个并排（8.4 审查 S2-M3）
            <div className="flex flex-wrap items-start gap-2">
              <ReworkPanel
                label="打回意见"
                placeholder="写清楚哪张图不对、要换成什么，例如：第 3 张换成正面照；主题跑偏了，要讲的是国产品牌"
                blocked={data.reworkBlocked ?? busyReason ?? (approve.isPending ? "正在提交素材通过" : undefined)}
                busy={rework.isPending}
                onSubmit={(note) => rework.mutate(note)}
              />
              <Button
                variant="primary"
                className="ml-auto"
                loading={approve.isPending}
                disabled={data.approveBlocked !== null || busyReason !== undefined || rework.isPending}
                disabledReason={data.approveBlocked ?? busyReason ?? (rework.isPending ? "正在提交打回" : undefined)}
                onClick={() => approve.mutate()}
              >
                素材通过
              </Button>
            </div>
          ) : null}
        </aside>
      </div>

      <p className="text-caption text-text-tertiary">联网图片版权由使用者自行负责。</p>

      <AssetLightbox asset={zoom} onClose={() => setZoom(null)} />
      <ConfirmDialog
        open={confirmCancel}
        title={`取消变体「${name}」`}
        consequences={[
          "在跑的 Agent 会话会停下，正在渲染的出片会让 hypit 取消",
          "这条变体作废，之后不能再继续或重跑",
          "已经提交给 hypit 的出片仍计入批次已花",
        ]}
        confirmLabel="取消这条变体"
        busy={cancel.isPending}
        onConfirm={() => {
          setConfirmCancel(false);
          cancel.mutate();
        }}
        onCancel={() => setConfirmCancel(false)}
      />
    </section>
  );
}
