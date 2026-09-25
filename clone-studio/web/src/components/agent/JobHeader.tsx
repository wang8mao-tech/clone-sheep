import { useMutation } from "@tanstack/react-query";
import { Square } from "lucide-react";
import { agentApi, isActive, type AgentJobView } from "../../lib/agent.js";
import { statusMarkOf } from "../../lib/agent-status.js";
import { COST_UNKNOWN, costUnknown, formatUsd } from "../../lib/format.js";
import { formatRunElapsed } from "../../lib/run-elapsed.js";
import { Button } from "../ui/Button.js";
import { StatusMark } from "../ui/StatusMark.js";

/**
 * 抽屉顶栏（Design-Brief §A.3「长任务进度」）：状态、模型档案名与模型 id、本次运行用时、
 * 等价花费 / 熔断上限、「中止」。只有「中止」，没有「取消任务」（DEV-PLAN 5.3 交接）。
 */
export function JobHeader({
  job,
  budgetUsd,
  now,
  onJob,
}: {
  job: AgentJobView;
  /** 设置页的花费熔断上限；还没读到时为 null */
  budgetUsd: number | null;
  now: number;
  onJob: (job: AgentJobView) => void;
}) {
  const abort = useMutation({
    mutationFn: () => agentApi.abort(job.id),
    onSuccess: (res) => onJob(res.job),
  });
  const mark = statusMarkOf(job.status);
  const model = [job.profileName, job.modelId ?? "订阅默认模型"].filter(Boolean).join(" · ");

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <StatusMark status={mark.kind} {...(mark.label ? { label: mark.label } : {})} />
        {isActive(job.status) ? (
          <Button
            variant="ghost"
            className="h-7 px-2"
            icon={<Square aria-hidden className="size-3" />}
            loading={abort.isPending}
            onClick={() => abort.mutate()}
          >
            中止
          </Button>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-3 text-caption text-text-secondary">
        <span className="min-w-0 flex-1 truncate" title={model}>
          {model}
        </span>
        <span className="shrink-0" aria-label="用时">
          {formatRunElapsed(job, now)}
        </span>
        {costUnknown(job) ? (
          // 没填单价：花费算不出、也没有 $ 熔断，不能摆一个「$0.00 / $5.00」让人以为又便宜又有兜底（10.4 审查 S1-M2）
          <span className="shrink-0 text-text-tertiary" aria-label="花费与上限" title="这个档案没填单价：没有 $ 熔断">
            {COST_UNKNOWN}
          </span>
        ) : (
          <span className="shrink-0" aria-label="花费与上限">
            {formatUsd(job.costUsd)}
            <span className="text-text-tertiary"> / {budgetUsd === null ? "—" : formatUsd(budgetUsd)}</span>
            {job.costIsEstimate ? <span className="text-text-tertiary"> 估</span> : null}
          </span>
        )}
      </div>
      {abort.isError ? (
        <div role="alert" className="text-caption break-words text-danger">
          中止失败：{abort.error.message}
        </div>
      ) : null}
    </div>
  );
}
