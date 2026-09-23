import { describeNextActions, describeStop, END_TITLE, type EndedJob } from "../../lib/agent-status.js";
import { formatUsd } from "../../lib/format.js";
import { formatRunElapsed } from "../../lib/run-elapsed.js";
import type { Tone } from "../../lib/agent-timeline.js";
import { ToneBlock } from "./ToneBlock.js";

/**
 * 会话流末尾的结束卡（Design-Brief §A.3）：原因 + 用时 + 花费。
 * 动作按钮（继续 / 重跑）在工作区 CMP-009（Task 5.5），这里只说明还能做什么。
 */
export function EndCard({ job, now }: { job: EndedJob; now: number }) {
  const reason = describeStop(job);
  const next = describeNextActions(job.status);
  const tone: Tone = job.status === "tripped" || job.status === "failed" ? "danger" : null;
  return (
    <div
      role="status"
      aria-label={`结束：${END_TITLE[job.status]}`}
      className="mx-3 mb-3 rounded-md border border-border bg-surface px-3 py-2"
    >
      <ToneBlock tone={tone} className="ml-0.5">
        <div className={job.status === "done" ? "text-success" : tone ? "text-danger" : "text-text"}>
          {END_TITLE[job.status]}
        </div>
        {reason ? <div className="break-words text-text-secondary">{reason}</div> : null}
        <div className="mt-1 flex gap-4 text-caption text-text-tertiary">
          <span>用时 {formatRunElapsed(job, now)}</span>
          <span>
            花费 {formatUsd(job.costUsd)}
            {job.costIsEstimate ? "（估）" : ""}
          </span>
        </div>
        {next ? <div className="mt-1 text-caption text-text-tertiary">{next}</div> : null}
      </ToneBlock>
    </div>
  );
}
