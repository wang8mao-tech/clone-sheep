import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { isActive, type AgentJobView } from "../../lib/agent.js";
import { isEnded } from "../../lib/agent-status.js";
import { buildTimeline, lastActivityAt, latestTodos } from "../../lib/agent-timeline.js";
import type { Settings } from "../../lib/types.js";
import { useTemplateAgent } from "../../lib/agent-feed-context.js";
import { DrawerFrame } from "./DrawerFrame.js";
import { EndCard } from "./EndCard.js";
import { JobHeader } from "./JobHeader.js";
import { MessageStream } from "./MessageStream.js";
import { TodoList } from "./TodoList.js";

/**
 * 右侧 Agent 过程抽屉（REQ-003，Design-Brief §A）：只读观察窗。
 * 顶栏（状态、档案与模型、用时、花费 / 上限、中止）→ 待办 → 会话流 → 结束卡。
 *
 * 在模板页之外没有任务可看，只留外壳。开合：用户动过就听用户的；没动过时有任务就展开。
 */
export function AgentDrawer() {
  const { templateId, state, feed } = useTemplateAgent();
  const [pinned, setPinned] = useState<boolean | null>(null);
  const job = state.job;
  // 取数失败也展开：收着的话「读不到」这件事没人看得见，在跑的任务就这么隐形了
  const open = pinned ?? Boolean(job || state.error);
  const running = job?.status === "running";
  // 用时、工具耗时、「思考中」只在运行中走表；排队、等额度时用时本来就冻住
  const now = useNow(open && running);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/api/settings"),
    enabled: open && job !== null,
  });

  const items = useMemo(() => buildTimeline(state.messages), [state.messages]);
  const todos = useMemo(() => latestTodos(state.messages), [state.messages]);
  const lastActivity = useMemo(() => lastActivityAt(state.messages), [state.messages]);
  const lastAt = lastActivity ?? job?.runStartedAt ?? null;

  const header = job ? (
    <JobHeader
      job={job}
      budgetUsd={settings.data?.agentBudgetUsd ?? null}
      now={now}
      onJob={(v) => feed?.replaceJob(v)}
    />
  ) : (
    <span className="text-heading-md">Agent 过程</span>
  );

  return (
    <DrawerFrame open={open} onOpenChange={setPinned} header={header} railBadge={job ? <RailBadge job={job} /> : null}>
      {job?.status === "awaiting_quota" ? <QuotaBar job={job} /> : null}
      {todos && todos.length > 0 ? <TodoList todos={todos} running={running} /> : null}
      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-border px-3 py-1.5 text-caption text-danger"
        >
          <span className="min-w-0 flex-1 break-words">读取 Agent 消息失败：{state.error}</span>
          <button
            type="button"
            onClick={() => void feed?.retry()}
            className="min-h-7 shrink-0 text-text-secondary underline hover:text-text"
          >
            重试
          </button>
        </div>
      ) : null}
      {!templateId ? (
        <Empty text="打开一个模板，这里显示它的 Agent 过程。" />
      ) : !state.loaded ? (
        <Skeleton />
      ) : !job ? (
        <Empty text="这个模板还没有 Agent 任务。" />
      ) : (
        <>
          <MessageStream
            items={items}
            liveAfterSeq={state.liveAfterSeq}
            running={running}
            lastAt={lastAt}
            now={now}
            hasOlder={state.hasOlder}
            loadingOlder={state.loadingOlder}
            onLoadOlder={() => void feed?.loadOlder()}
          />
          {isEnded(job) ? <EndCard job={job} now={now} /> : null}
        </>
      )}
    </DrawerFrame>
  );
}

/** 收起时竖条上的一个点：任务没结束就亮着（运行中脉动），收着也知道后台有东西在跑 */
function RailBadge({ job }: { job: AgentJobView }) {
  if (!isActive(job.status)) return null;
  const running = job.status === "running";
  return (
    <span
      role="img"
      aria-label={running ? "Agent 任务运行中" : "Agent 任务未结束"}
      className={["inline-block size-2 rounded-full", running ? "animate-pulse bg-primary" : "bg-info"].join(" ")}
    />
  );
}

/** 等待额度：顶栏下蓝灰条（Design-Brief §A.3） */
function QuotaBar({ job }: { job: AgentJobView }) {
  const at = job.resumeAt ? new Date(job.resumeAt) : null;
  const time =
    at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div role="status" className="border-b border-border bg-info/15 px-3 py-1.5 text-caption text-info">
      额度受限{time ? ` · 预计 ${time} 恢复后自动继续` : " · 恢复后自动继续"}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-3 py-3 text-caption text-text-tertiary">{text}</p>;
}

function Skeleton() {
  return (
    <div aria-label="加载中" className="flex flex-col gap-2 px-3 py-3">
      {[70, 90, 55].map((w) => (
        <div key={w} className="h-3 animate-pulse rounded-sm bg-surface-raised" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

/** 秒级时钟：只在有东西要走表时跳，其余时候不白白重渲染 */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    // 开始走表那一刻先对一次：不对的话要用挂载时的旧时间撑一秒，「用时」「思考中」会先显示成 0
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [ticking]);
  return now;
}
