import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { OctagonX, Pause } from "lucide-react";
import { agentApi } from "../lib/agent.js";
import type { AgentFeed } from "../lib/agent-feed.js";
import { describeStop, END_TITLE, isEnded, nextActions, type EndedJob } from "../lib/agent-status.js";
import { useTemplateAgent } from "../lib/agent-feed-context.js";
import { formatUsd } from "../lib/format.js";
import { formatRunElapsed } from "../lib/run-elapsed.js";
import { Button } from "./ui/Button.js";
import { ConfirmDialog } from "./ui/ConfirmDialog.js";

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
  if (!job || !isEnded(job) || nextActions(job.status).length === 0) return null;
  // 请求状态（进行中、失败原文）与确认框只属于「这一个任务的这一次停下」：换了模板、换了任务、
  // 任务状态变了，都整个重来。不然 A 模板「继续失败」的原文会挂到 B 模板的横条上（复审 S2-M1），
  // 开着的确认框也会在任务再次停下时自己弹出来（S2-L1）
  return <BarBody key={`${job.id}:${job.status}:${job.endedAt ?? ""}`} job={job} feed={feed} />;
}

function BarBody({ job, feed }: { job: EndedJob; feed: AgentFeed | null }) {
  const [confirming, setConfirming] = useState(false);
  const cont = useMutation({
    mutationFn: (jobId: string) => agentApi.continue(jobId),
    onSuccess: (res) => feed?.replaceJob(res.job),
  });
  const rerun = useMutation({
    mutationFn: (jobId: string) => agentApi.rerun(jobId),
    onSuccess: (res) => {
      setConfirming(false);
      // 重跑出来的是新任务：抽屉与横条一起换过去（同一个模板主题的 agent-job 事件也会来，重复无害）
      void feed?.jobChanged(res.job);
    },
    // 失败时关掉确认框，原文显示在横条上，可以再点
    onError: () => setConfirming(false),
  });

  const actions = nextActions(job.status);
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
          用时 {formatRunElapsed(job, ENDED)} · 花费 {formatUsd(job.costUsd)}
          {job.costIsEstimate ? "（估）" : ""}
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
        consequences={[
          // 与 server/src/hypit/workspace.ts resetAgentProducts 一致：只清顶层，三个目录整个留着
          "会删掉 Agent 在工作目录顶层写出的文件（ANALYSIS.md、TIMELINE.md、reference.svml 等）",
          "references、assets、productions 三个目录（证据、素材、变体数据）整个保留",
          "按原来的任务提示开一个新会话从头做，之前的会话不再接着用",
        ]}
        confirmLabel="清掉产物并重跑"
        busy={rerun.isPending}
        onConfirm={() => rerun.mutate(job.id)}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
