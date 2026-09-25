import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { BuildCard } from "../../components/clone/BuildCard.js";
import { SyncPlayers } from "../../components/SyncPlayers.js";
import type { VideoMeta } from "../../components/useSyncPlayback.js";
import { Badge } from "../../components/ui/Badge.js";
import { Button } from "../../components/ui/Button.js";
import { QueryErrorState } from "../../components/ui/QueryErrorState.js";
import { useTemplateAgent } from "../../lib/agent-feed-context.js";
import { archiveKeys, type TemplateDetail } from "../../lib/archive.js";
import { cloneKeys } from "../../lib/clone.js";
import { evidenceApi, evidenceKeys } from "../../lib/evidence.js";
import { describeDiff, reviewApi, reviewKeys, type ReviewState } from "../../lib/review.js";
import { ReworkPanel } from "./ReworkPanel.js";

/**
 * SCREEN-005 模板 · ③ 验货（REQ-004 后半，FLOW-002 步骤 6-7）。
 *
 * 主内容：CMP-004 并排播放器，左原片、右复刻片 vN；下方一行两片的时长差与分辨率差，版本用分段控件切换（这一轮的 v1 / v2 …）。
 * 底部固定操作区：左「打回」（次按钮，展开意见框）、右「通过验货」（主按钮，只对最新一版可用）。
 * 通过后 ④ 解锁并跳过去；打回后回到 ② 看 Agent 改稿（抽屉里是「打回意见 #n」一轮）。
 * 选中的那一版没出好（出片失败 / 取消）时右边换成 CMP-007 出片卡，沿用它的原文与「重试出片」。
 */
export function ReviewStep() {
  const { templateId = "" } = useParams();
  return (
    <section aria-label="③ 验货 工作区" className="flex flex-1 flex-col">
      <ReviewBody key={templateId} templateId={templateId} />
    </section>
  );
}

function ReviewBody({ templateId }: { templateId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { clientId = "" } = useParams();
  const { feed } = useTemplateAgent();
  const review = useQuery({
    queryKey: reviewKeys.state(templateId),
    queryFn: () => reviewApi.state(templateId),
    retry: false,
  });
  // 左路参考视频的版本号与帧率（逐帧按原片 fps 走）
  const evidence = useQuery({
    queryKey: evidenceKeys.state(templateId),
    queryFn: () => evidenceApi.state(templateId),
    retry: false,
  });
  const [picked, setPicked] = useState<string | null>(null);
  // 右路的元数据按版本记：切到别的版本时不能拿上一版的数去算差（7.3 审查 MEDIUM-1）
  const [meta, setMeta] = useState<{ left?: VideoMeta; right: Record<string, VideoMeta> }>({ right: {} });

  // 验货状态会被打回 / 通过 / 出片推着变：这几种事件都让它重拉
  useEffect(() => {
    if (!feed) return;
    const refresh = (): void => void qc.invalidateQueries({ queryKey: reviewKeys.state(templateId) });
    const offs = (["review", "build", "clone"] as const).map((name) => feed.onTemplateEvent(name, refresh));
    return () => offs.forEach((off) => off());
  }, [feed, qc, templateId]);

  const afterChange = (): void => {
    void qc.invalidateQueries({ queryKey: reviewKeys.state(templateId) });
    void qc.invalidateQueries({ queryKey: archiveKeys.template(templateId) });
    void qc.invalidateQueries({ queryKey: cloneKeys.state(templateId) });
  };
  const hrefFor = (step: string): string => `/clients/${clientId}/templates/${templateId}/${step}`;
  /**
   * 跳步之前先把缓存里的模板状态改成新的：布局按缓存里的状态判步骤能不能进，重拉还没回来时
   * 拿旧状态（等验货）会把人从 ④ 送回 ③，之后再也不跳（7.3 审查 HIGH-1，同 ① 参考当年的竞态）
   */
  const markTemplate = (status: TemplateDetail["status"]): void => {
    qc.setQueryData<TemplateDetail>(archiveKeys.template(templateId), (old) => (old ? { ...old, status } : old));
  };
  const approve = useMutation({
    mutationFn: (productionId: string) => reviewApi.approve(templateId, productionId),
    onSuccess: (state) => {
      qc.setQueryData(reviewKeys.state(templateId), state);
      markTemplate("approved");
      afterChange();
      // SCREEN-005 成功态：④ 解锁并自动跳过去
      void navigate(hrefFor("variants"));
    },
    // 被拒（不是最新一版了、任务在跑）：按钮状态是旧的，重拉一次让它跟上
    onError: () => void qc.invalidateQueries({ queryKey: reviewKeys.state(templateId) }),
  });
  const rework = useMutation({
    mutationFn: (note: string) => reviewApi.rework(templateId, note),
    onSuccess: (res) => {
      qc.setQueryData(reviewKeys.state(templateId), res.review);
      markTemplate("cloning");
      void feed?.jobChanged(res.job);
      afterChange();
      void navigate(hrefFor("clone"));
    },
    onError: () => void qc.invalidateQueries({ queryKey: reviewKeys.state(templateId) }),
  });

  if (review.isPending) return <p className="text-caption text-text-secondary">读取验货状态…</p>;
  if (review.error) {
    return (
      <QueryErrorState
        error={review.error}
        goneText="这个模板已经不存在了"
        errorText="读不到验货状态"
        retrying={review.isFetching}
        onRetry={() => void review.refetch()}
      />
    );
  }
  const data = review.data;
  const latest = data.versions.at(-1);
  if (!latest) {
    return <p className="text-caption text-text-secondary">这一轮还没有复刻片，出好后在这里和原片并排对比。</p>;
  }
  const shown = data.versions.find((v) => v.id === picked) ?? latest;
  const fetched = evidence.data?.steps.find((s) => s.step === "fetch");
  const referenceSrc = `/api/templates/${templateId}/reference/video?v=${encodeURIComponent(fetched?.endedAt ?? "")}`;
  // 选中的版本没片（出片卡顶上）就不说差异
  const diff = shown.videoUrl ? describeDiff(meta.left, meta.right[shown.id]) : null;
  // 证据状态回来再挂播放器：不然左路地址会从 ?v= 变成 ?v=<时间>、帧率从 30 变成探测值，参考视频要加载两次
  const evidenceSettled = !evidence.isPending;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <VersionPicker data={data} shownId={shown.id} onPick={(id) => setPicked(id)} />
        {data.approvedReplicaId ? (
          <Badge tone="success">
            已通过验货 · v{data.versions.find((v) => v.id === data.approvedReplicaId)?.version ?? "?"}
          </Badge>
        ) : null}
        {diff ? <span className="font-mono text-caption text-text-secondary">{diff}</span> : null}
      </div>

      {shown.videoUrl && !evidenceSettled ? (
        <p className="text-caption text-text-secondary">读取参考视频…</p>
      ) : shown.videoUrl ? (
        <SyncPlayers
          left={{ label: "原片", src: referenceSrc }}
          right={{ label: `复刻片 v${shown.version}`, src: shown.videoUrl }}
          fps={evidence.data?.probe?.frameRate}
          onMeta={(side, m) =>
            setMeta((prev) =>
              side === "left" ? { ...prev, left: m } : { ...prev, right: { ...prev.right, [shown.id]: m } },
            )
          }
        />
      ) : shown.outputDeleted ? (
        // 出片卡会说「已出片、在 ③ 并排看」，而文件已经删了（9.1 第三轮审查 S1-M2）
        // 只在真能打回时才提打回：已通过验货、看的是旧版、会话不在，都打回不了（9.1 第四轮审查 S1-M1）
        <p className="text-caption text-text-secondary">
          {shown.id === latest.id && data.reworkable
            ? "这一版的成片已在 ⑤ 删掉了，打回重出一版。"
            : "这一版的成片已在 ⑤ 删掉了。"}
        </p>
      ) : (
        <div className="max-w-[360px]">
          <BuildCard productionId={shown.id} />
        </div>
      )}

      <ActionBar
        data={data}
        shownIsLatest={shown.id === latest.id}
        latestVersion={latest.version}
        approve={{ busy: approve.isPending, run: () => approve.mutate(latest.id) }}
        rework={{ busy: rework.isPending, run: (note) => rework.mutate(note) }}
        lastError={rework.isPending || approve.isPending ? null : latestError(approve, rework)}
      />
    </div>
  );
}

function VersionPicker({
  data,
  shownId,
  onPick,
}: {
  data: ReviewState;
  shownId: string;
  onPick: (id: string) => void;
}) {
  if (data.versions.length < 2) {
    return <span className="text-caption text-text-secondary">复刻片 v{data.versions[0]?.version}</span>;
  }
  return (
    <div role="group" aria-label="版本" className="flex items-center gap-xs">
      {data.versions.map((v) => (
        <Button
          key={v.id}
          variant={v.id === shownId ? "secondary" : "ghost"}
          aria-pressed={v.id === shownId}
          onClick={() => onPick(v.id)}
          className="px-2 font-mono tabular-nums"
        >
          v{v.version}
        </Button>
      ))}
    </div>
  );
}

type Attempt = { error: Error | null; submittedAt: number };
/**
 * 最近一次失败的那个动作，带上是哪个动作（后发生的在前）：不能让旧的通过错误盖住新的打回错误（7.3 审查 L-2），
 * 传输错误只有「后端未响应」时也要看得出是通过还是打回没成（第二轮 L-1，仿 ② 的「复刻没有开始：」）
 */
function latestError(approve: Attempt, rework: Attempt): string | null {
  const a = approve.error ? `通过验货没成功：${approve.error.message}` : null;
  const r = rework.error ? `打回没提交：${rework.error.message}` : null;
  if (a && r) return approve.submittedAt >= rework.submittedAt ? a : r;
  return a ?? r;
}

interface ActionState<A extends unknown[]> {
  busy: boolean;
  run: (...args: A) => void;
}

/** 底部固定操作区（SCREEN-005）：左打回（次按钮），右通过验货（主按钮） */
function ActionBar({
  data,
  shownIsLatest,
  latestVersion,
  approve,
  rework,
  lastError,
}: {
  data: ReviewState;
  shownIsLatest: boolean;
  latestVersion: number;
  approve: ActionState<[]>;
  rework: ActionState<[string]>;
  lastError: string | null;
}) {
  const approveBlocked = !data.approvable
    ? data.templateStatus === "approved"
      ? "已经通过验货了"
      : data.versions.at(-1)?.outputDeleted
        ? data.reworkable
          ? "这一版的成片已在 ⑤ 删掉了，打回重出一版"
          : "这一版的成片已在 ⑤ 删掉了"
        : "复刻片出好之后才能验货"
    : !shownIsLatest
      ? `只能通过最新一版 v${latestVersion}`
      : undefined;
  const reworkBlocked = data.reworkable
    ? undefined
    : data.templateStatus === "approved"
      ? "已经通过验货了，不能打回"
      : "最新一版出好之后才能打回";
  // 两个动作互斥：一个在提交时另一个不可点（7.3 审查 L-3）
  const busy = approve.busy || rework.busy;
  return (
    // 贴在工作区底边（工作区有 py-5，-bottom-5 抵掉它）；内容不满一屏时 mt-auto 把它推到底（MEDIUM-4）
    <div className="sticky -bottom-5 -mx-6 -mb-5 mt-auto flex flex-col gap-3 border-t border-border bg-bg px-6 py-3">
      {lastError ? (
        <p role="alert" className="text-caption text-danger">
          {lastError}
        </p>
      ) : null}
      <div className="flex items-start gap-3">
        <ReworkPanel
          round={data.nextRound}
          blocked={reworkBlocked ?? (approve.busy ? "正在提交通过验货" : undefined)}
          busy={rework.busy}
          onSubmit={rework.run}
        />
        <Button
          variant="primary"
          className="ml-auto"
          loading={approve.busy}
          disabled={approveBlocked !== undefined || busy}
          disabledReason={approveBlocked ?? (rework.busy ? "正在提交打回" : undefined)}
          onClick={() => approve.run()}
        >
          通过验货
        </Button>
      </div>
    </div>
  );
}
