import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { OctagonX, Pause } from "lucide-react";
import { agentApi } from "../lib/agent.js";
import type { AgentFeed } from "../lib/agent-feed.js";
import {
  allowedActions,
  describeStop,
  END_TITLE,
  isEnded,
  type ActionGate,
  type EndedJob,
} from "../lib/agent-status.js";
import { useTemplateAgent } from "../lib/agent-feed-context.js";
import { COST_UNKNOWN, costUnknown, formatUsd } from "../lib/format.js";
import { formatRunElapsed } from "../lib/run-elapsed.js";
import { Button } from "./ui/Button.js";
import { ConfirmDialog } from "./ui/ConfirmDialog.js";
import { useProfileChoice } from "../lib/useProfileChoice.js";
import { ModelSelect } from "./ModelSelect.js";
import { SUBSCRIPTION_PROFILE_ID } from "../lib/model-profiles.js";

/** 横条只对已经结束的任务出现，终态的用时只认累计值、不看 now：给个固定值，不在渲染里取时钟 */
const ENDED = 0;

/**
 * CMP-009 熔断 / 中断横条（Design-Brief §4）：原因 + 用时与花费 + 「继续」「重跑」。
 * 挂在模板页步骤条下方、工作区上方；Phase 6 的 ② 复刻页沿用这一个（SCREEN-004 错误态）。
 *
 * 只在任务停下、还能接着处理时出现：已熔断 / 失败是红条，中断 / 已取消是灰条；完成的没有横条。
 * 动作照 nextActions：已取消的没有会话可 resume，只给「重跑」。没有「取消任务」这一项。
 * 任务数据与右侧抽屉是同一份（AgentFeedProvider），点完动作两边一起换。
 */
export function BreakerBar() {
  const { state, feed } = useTemplateAgent();
  const job = state.job;
  // 跟着变体时还要看这条变体此刻允许什么：作废的、交给出片的不给注定被拒的继续 / 重跑（9.3 审查 S1-M2）
  const gate = state.gate ?? null;
  if (!job || !isEnded(job) || allowedActions(job.status, gate).length === 0) return null;
  // 请求状态（进行中、失败原文）与确认框只属于「这一个任务的这一次停下」：换了模板、换了任务、
  // 任务状态变了，都整个重来。不然 A 模板「继续失败」的原文会挂到 B 模板的横条上（复审 S2-M1），
  // 开着的确认框也会在任务再次停下时自己弹出来（S2-L1）
  return <BarBody key={`${job.id}:${job.status}:${job.endedAt ?? ""}`} job={job} feed={feed} gate={gate} />;
}

function BarBody({ job, feed, gate }: { job: EndedJob; feed: AgentFeed | null; gate: ActionGate }) {
  const [confirming, setConfirming] = useState(false);
  // 重跑可重选档案，默认原档案（REQ-010、CMP-009「重跑可重选模型」）；复刻的任务要支持看图
  // 没记档案的老任务原来就在内置订阅上跑（server rerunChoice 同一口径，10.4 审查 S1-M1）
  const original = job.profileId ?? SUBSCRIPTION_PROFILE_ID;
  const model = useProfileChoice(job.ownerKind === "template" ? "vision" : null, original);
  const cont = useMutation({
    mutationFn: (jobId: string) => agentApi.continue(jobId),
    onSuccess: (res) => feed?.replaceJob(res.job),
  });
  const rerun = useMutation({
    // 没换档案就不带：交给服务端按原档案重跑（老任务的「订阅 + 指定模型」也照原样）
    mutationFn: (jobId: string) => agentApi.rerun(jobId, model.profileId !== original ? model.profileId : null),
    onSuccess: (res) => {
      setConfirming(false);
      // 重跑出来的是新任务：抽屉与横条一起换过去（同一个模板主题的 agent-job 事件也会来，重复无害）
      void feed?.jobChanged(res.job);
    },
    // 失败时关掉确认框，原文显示在横条上，可以再点
    onError: () => setConfirming(false),
  });

  const actions = allowedActions(job.status, gate);
  const red = job.status === "tripped" || job.status === "failed";
  const reason = describeStop(job);
  const busy = cont.isPending || rerun.isPending;
  const busyReason = busy ? "正在处理上一个操作" : undefined;
  const error = cont.error ?? rerun.error;

  return (
    // role=status 而不是 alert：打开一个停着的模板不该抢读屏，与 HealthBanner 同一先例
    <div
      role="status"
      aria-label={`任务${END_TITLE[job.status]}`}
      className={[
        "flex shrink-0 flex-col gap-1 border-b px-6 py-2",
        red ? "border-danger/40 bg-danger/10" : "border-border bg-surface-raised",
      ].join(" ")}
    >
      <div className="flex items-center gap-3">
        {red ? (
          <OctagonX aria-hidden className="size-4 shrink-0 text-danger" />
        ) : (
          <Pause aria-hidden className="size-4 shrink-0 text-text-secondary" />
        )}
        <span className={["min-w-0 flex-1 text-[13px]", red ? "text-danger" : "text-text"].join(" ")}>
          {END_TITLE[job.status]}
          {reason ? `：${reason}` : ""}
        </span>
        <span className="shrink-0 font-mono text-caption text-text-secondary">
          用时 {formatRunElapsed(job, ENDED)} · 花费 {costUnknown(job) ? COST_UNKNOWN : formatUsd(job.costUsd)}
          {job.costIsEstimate && !costUnknown(job) ? "（估）" : ""}
        </span>
        {actions.includes("continue") ? (
          <Button
            variant="secondary"
            loading={cont.isPending}
            disabled={busy}
            disabledReason={busyReason}
            onClick={() => {
              rerun.reset();
              cont.mutate(job.id);
            }}
          >
            继续
          </Button>
        ) : null}
        {actions.includes("rerun") ? (
          <Button
            variant="ghost"
            disabled={busy}
            disabledReason={busyReason}
            onClick={() => {
              cont.reset();
              setConfirming(true);
            }}
          >
            重跑
          </Button>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="text-caption break-words text-danger">
          {cont.error ? "继续" : "重跑"}失败：{error.message}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="重跑这个任务？"
        consequences={
          job.ownerKind === "production"
            ? [
                // 变体的重跑（服务端转到 rerunVariant，同 ④ 队列的重跑）：只清 Agent 的产物，你换过的图留着
                "清掉这条变体 Agent 写的稿子、清单与抓来的图（你替换过的图留着），素材要重新审",
                "按原来的 brief 与下面选的档案开一个新会话从头写，之前的会话不再接着用",
              ]
            : [
                // 与 server/src/hypit/workspace.ts resetAgentProducts 一致：只清顶层，三个目录整个留着
                "会删掉 Agent 在工作目录顶层写出的文件（ANALYSIS.md、TIMELINE.md、reference.svml 等）",
                "references、assets、productions 三个目录（证据、素材、变体数据）整个保留",
                "按原来的任务提示与下面选的档案开一个新会话从头做，之前的会话不再接着用",
              ]
        }
        confirmLabel="清掉产物并重跑"
        busy={rerun.isPending}
        onConfirm={() => rerun.mutate(job.id)}
        onCancel={() => setConfirming(false)}
      >
        <ModelSelect
          label="用哪个模型档案重跑"
          need={job.ownerKind === "template" ? "vision" : null}
          profiles={model.profiles}
          value={model.profileId}
          onChange={model.setProfileId}
          error={model.error}
          onRetry={model.retry}
          fallbackText="重跑会沿用原档案。"
          disabled={rerun.isPending}
        />
      </ConfirmDialog>
    </div>
  );
}
