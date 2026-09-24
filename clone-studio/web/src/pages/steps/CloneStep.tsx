import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import { QuotaBar } from "../../components/agent/QuotaBar.js";
import { AnalysisSection, TimelineSection, VerdictSection } from "../../components/clone/CloneSections.js";
import { BuildCard } from "../../components/clone/BuildCard.js";
import { EstimateCard } from "../../components/clone/EstimateCard.js";
import { Button } from "../../components/ui/Button.js";
import { QueryErrorState } from "../../components/ui/QueryErrorState.js";
import { StatusMark } from "../../components/ui/StatusMark.js";
import { isActive, type AgentJobView } from "../../lib/agent.js";
import { useTemplateAgent } from "../../lib/agent-feed-context.js";
import { cloneApi, cloneKeys, type CloneState } from "../../lib/clone.js";
import { evidenceApi, evidenceKeys } from "../../lib/evidence.js";
import { buildKeys } from "../../lib/build.js";
import { estimateKeys } from "../../lib/estimate.js";
import { formatUsd } from "../../lib/format.js";
import { api } from "../../lib/api.js";
import type { Settings } from "../../lib/types.js";
import { formatRunElapsed } from "../../lib/run-elapsed.js";
import { useNow } from "../../lib/useNow.js";

/** Agent 在跑时文件随时会多出来，后端没有「写了哪个文件」的事件，按这个间隔重拉；核判据期间同样 */
export const CLONE_POLL_MS = 3_000;

/**
 * SCREEN-004 模板 · ② 复刻（REQ-004，设计稿「② 复刻」）。
 *
 * 左：分析摘要 / 时间线 / 校验结果三个折叠区块，对应文件产生后逐个出现；右：参考视频小播放器
 * （设计稿 300px；1280 宽 + 抽屉时按 40% 收窄，最窄 220），时间线点时间码跳到该处；估价卡 CMP-006 在它下面（Task 6.3）。
 * 熔断 / 中断沿用布局里的 BreakerBar，任务数据与抽屉同一份（useTemplateAgent），判据结论的 `clone` 事件也走那条 SSE。
 */
export function CloneStep() {
  const { templateId = "" } = useParams();
  // 与其它步骤的工作区同一个地标：读屏跳转、测试定位都靠它。
  // key：换模板时整块重建，A 模板「开始失败」的原文、折叠状态不能带到 B 模板上
  return (
    <section aria-label="② 复刻 工作区">
      <CloneBody key={templateId} templateId={templateId} />
    </section>
  );
}

function CloneBody({ templateId }: { templateId: string }) {
  const qc = useQueryClient();
  const { state: agent, feed } = useTemplateAgent();
  const job = agent.job;
  const running = job ? isActive(job.status) : false;

  const clone = useQuery({
    queryKey: cloneKeys.state(templateId),
    queryFn: () => cloneApi.state(templateId),
    retry: false,
    // 核判据期间也要轮询：结论的 clone 事件若在断线时错过，不能停在「正在核对」上等人刷新
    refetchInterval: (query) => (running || query.state.data?.verifying ? CLONE_POLL_MS : false),
  });
  // 只为右侧播放器：源视频落盘了没有、拿什么版本号。读不到时降级成占位，不拖垮整页
  const evidence = useQuery({
    queryKey: evidenceKeys.state(templateId),
    queryFn: () => evidenceApi.state(templateId),
    retry: false,
  });

  useEffect(() => {
    if (!feed) return;
    const offClone = feed.onTemplateEvent(
      "clone",
      () => void qc.invalidateQueries({ queryKey: cloneKeys.state(templateId) }),
    );
    // 估价结论出来：复刻片那张卡重拉（clone 快照也带复刻片状态，一起失效）
    const offEstimate = feed.onTemplateEvent("estimate", (data) => {
      const id = (data as { productionId?: unknown } | null)?.productionId;
      if (typeof id === "string") void qc.invalidateQueries({ queryKey: estimateKeys.production(id) });
      void qc.invalidateQueries({ queryKey: cloneKeys.state(templateId) });
    });
    // 出片进度 / 结果变了：那张卡重拉（复刻片状态也跟着 clone 快照走）
    const offBuild = feed.onTemplateEvent("build", (data) => {
      const id = (data as { productionId?: unknown } | null)?.productionId;
      if (typeof id === "string") void qc.invalidateQueries({ queryKey: buildKeys.production(id) });
      void qc.invalidateQueries({ queryKey: cloneKeys.state(templateId) });
    });
    return () => {
      offClone();
      offEstimate();
      offBuild();
    };
  }, [feed, qc, templateId]);
  // 估价卡要画单条限额的进度条
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });

  // 任务一结束（完成 / 熔断 / 失败）立刻补拉一次：最后写出的文件赶在轮询间隔之内也不会漏
  const jobStatus = job?.status;
  useEffect(() => {
    if (jobStatus && !isActive(jobStatus)) void qc.invalidateQueries({ queryKey: cloneKeys.state(templateId) });
  }, [jobStatus, qc, templateId]);

  const start = useMutation({
    mutationFn: () => cloneApi.start(templateId),
    onSuccess: (res) => void feed?.jobChanged(res.job),
  });

  const video = useRef<HTMLVideoElement>(null);
  const seek = (seconds: number): void => {
    const el = video.current;
    if (!el) return;
    el.currentTime = seconds;
    el.scrollIntoView?.({ block: "nearest" });
  };

  if (clone.error) {
    return (
      <QueryErrorState
        error={clone.error}
        goneText="这个模板已经不存在了。"
        errorText="读不到复刻结果。"
        retrying={clone.isFetching}
        onRetry={() => void clone.refetch()}
      />
    );
  }
  // Agent 快照读失败时抽屉里有重试，工作区也得有：抽屉收起时人没有别的出口
  if (!agent.loaded && agent.error) {
    return (
      <QueryErrorState
        error={new Error(agent.error)}
        goneText="这个模板已经不存在了。"
        errorText="读不到这个模板的 Agent 任务。"
        onRetry={() => void feed?.retry()}
      />
    );
  }
  if (!clone.data || !agent.loaded) {
    return <p className="text-[13px] text-text-secondary">正在读取复刻结果…</p>;
  }

  const data = clone.data;
  const fetched = evidence.data?.steps.find((s) => s.step === "fetch");
  const canSeek = fetched?.status === "done";
  const nothingYet = !data.analysis && !data.timeline && !data.verdict;

  return (
    <div className="flex items-start gap-5">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {job?.status === "awaiting_quota" ? <QuotaBar job={job} /> : null}
        {job && running ? <RunningLine job={job} /> : null}
        {data.analysis ? <AnalysisSection file={data.analysis} /> : null}
        {data.timeline ? <TimelineSection file={data.timeline} canSeek={canSeek} onSeek={seek} /> : null}
        {data.verdict ? <VerdictSection verdict={data.verdict} /> : null}
        {data.verifying ? (
          <p role="status" className="text-caption text-text-secondary">
            Agent 报告完成，正在核对完成判据（hypit check）…
          </p>
        ) : null}
        {nothingYet && !job ? (
          // 到得了 ② 说明证据已经做完；自动启动只对新完成的导入生效（REQ-004），这里没有任务就只能手动开
          <div className="flex items-center gap-3">
            <p className="text-[13px] text-text-secondary">还没有复刻任务。</p>
            <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>
              手动开始复刻
            </Button>
          </div>
        ) : null}
        {start.error ? (
          <p role="alert" className="text-caption text-danger">
            复刻没有开始：{start.error instanceof Error ? start.error.message : String(start.error)}
          </p>
        ) : null}
        {nothingYet && running ? (
          <p className="text-caption text-text-secondary">分析摘要、时间线写出来后会依次出现在这里。</p>
        ) : null}
        {nothingYet && job && !running && !data.verifying ? (
          <p className="text-caption text-text-secondary">
            这次复刻没有写出分析和时间线，用上方横条「继续」或「重跑」。
          </p>
        ) : null}
      </div>

      {/* 吸顶：1280 下时间线排在播放器下面，点时间码后播放器不能滚出视野 */}
      <div className="sticky top-0 flex min-w-[220px] basis-[40%] shrink-0 flex-col gap-3 self-start max-w-[300px]">
        {canSeek ? (
          <video
            ref={video}
            // 重新导入后文件内容变了而地址没变，用下载完成时间作版本号逼浏览器重取（同 ① 参考）
            key={fetched.endedAt ?? ""}
            aria-label="参考视频"
            controls
            preload="metadata"
            src={`/api/templates/${templateId}/reference/video?v=${encodeURIComponent(fetched.endedAt ?? "")}`}
            className="h-[260px] w-full rounded-md border border-border bg-black object-contain"
          />
        ) : (
          <div className="flex h-[260px] w-full items-center justify-center rounded-md border border-border bg-[repeating-linear-gradient(135deg,#1a1c20_0_10px,#15171a_10px_20px)]">
            <span className="font-mono text-[11px] text-text-tertiary">
              {evidence.error ? "参考视频 · 读不到准备状态" : "参考视频"}
            </span>
          </div>
        )}
        {/* CMP-006：判据通过、复刻片排上队之后才有估价；过了闸门之后换成 CMP-007 出片卡（进度 / 结果 / 失败重试） */}
        {data.replica && showsEstimate(data.replica) && settings.data ? (
          <EstimateCard productionId={data.replica.id} perItemLimitUsd={settings.data.perItemLimitUsd} />
        ) : null}
        {data.replica && showsBuild(data.replica) ? <BuildCard productionId={data.replica.id} /> : null}
      </div>
    </div>
  );
}

type Replica = NonNullable<CloneState["replica"]>;

/** 闸门前（排队 / 待确认），以及估价没过的失败（没出过片）：估价卡，能重估 */
function showsEstimate(r: Replica): boolean {
  return r.status === "queued" || r.status === "awaiting_cost_confirm" || (r.status === "failed" && r.buildId === null);
}

/** 过了闸门：出片卡（进度 / 结果 / 出片失败或取消后的重试） */
function showsBuild(r: Replica): boolean {
  return (
    r.status === "building" ||
    r.status === "done" ||
    r.status === "interrupted" ||
    (r.status === "failed" && r.buildId !== null)
  );
}

/** 「复刻进行中」+ 用时 / 等价花费 / 所用模型（SCREEN-004 加载态）。状态词才是 status 区，走表的数字不进读屏 */
function RunningLine({ job }: { job: AgentJobView }) {
  const now = useNow(job.status === "running");
  const quota = job.status === "awaiting_quota";
  return (
    <div className="flex flex-wrap items-center gap-2 text-caption text-text-secondary">
      <span role="status">
        <StatusMark
          status={quota ? "awaiting_quota" : job.status === "queued" ? "queued" : "agent_running"}
          label={quota ? "等待额度" : job.status === "queued" ? "复刻排队中" : "复刻进行中"}
        />
      </span>
      <span className="font-mono text-[12px] text-text tabular-nums">{formatRunElapsed(job, now)}</span>
      {/* 「· 值」成对不拆行：折行时分隔点不能悬在上一行末尾 */}
      <span className="whitespace-nowrap">
        <span aria-hidden>· </span>
        <span className="font-mono text-[12px] text-text tabular-nums">{formatUsd(job.costUsd)}</span>
        {/* REQ-009：估算值标「估」，与抽屉顶栏、横条同一个判断 */}
        {job.costIsEstimate ? <span> 估</span> : null}
      </span>
      {/* 与抽屉顶栏同一个写法：档案名 · 模型 id，没指定就是订阅的默认模型 */}
      <span className="whitespace-nowrap">
        <span aria-hidden>· </span>
        <span className="font-mono text-[11px]">
          {[job.profileName, job.modelId ?? "订阅默认模型"].filter(Boolean).join(" · ")}
        </span>
      </span>
    </div>
  );
}
