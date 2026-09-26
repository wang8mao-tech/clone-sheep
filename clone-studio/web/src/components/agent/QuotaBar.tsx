import type { AgentJobView } from "../../lib/agent.js";
import { formatResumeTime } from "../../lib/format.js";

/**
 * 等待额度：蓝灰横条（Design-Brief §A.3 抽屉顶栏下；SCREEN-004 工作区同一条）。
 * 抽屉里贴在顶栏下方（compact），工作区里是一张独立的横条
 */
export function QuotaBar({ job, compact = false }: { job: AgentJobView; compact?: boolean }) {
  const time = formatResumeTime(job.resumeAt);
  return (
    <div
      role="status"
      className={[
        "bg-info/15 text-caption text-info",
        compact ? "border-b border-border px-3 py-1.5" : "rounded-md border border-info/30 px-3 py-2",
      ].join(" ")}
    >
      额度受限{time ? ` · 预计 ${time} 恢复后自动继续` : " · 恢复后自动继续"}
    </div>
  );
}
