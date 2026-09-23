import { useEffect, useMemo, useSyncExternalStore } from "react";
import { agentApi, type AgentJobView } from "./agent.js";
import { AgentFeed, type FeedState } from "./agent-feed.js";

const IDLE: FeedState = {
  job: null,
  messages: [],
  loaded: true,
  hasOlder: false,
  loadingOlder: false,
  error: null,
  liveAfterSeq: 0,
};

/**
 * 模板的 Agent 任务 + 消息流。取数顺序见 AgentFeed 的说明：
 * 先开 SSE，`open`（含每一次自动重连）之后才去拉，所以快照和补齐永远发生在订阅之后。
 *
 * 知道任务 id 之后主题里加上 `job:<id>`，EventSource 随之重建——重建后的 `open` 走
 * 「对 seq 补齐」，快照和新订阅之间产生的消息由它补上。
 */
export function useAgentFeed(templateId: string | undefined): { state: FeedState; feed: AgentFeed | null } {
  const feed = useMemo(() => (templateId ? new AgentFeed(templateId, agentApi) : null), [templateId]);
  const state = useSyncExternalStore(feed?.subscribe ?? noopSubscribe, feed?.getState ?? idleState);
  const jobId = state.job?.id;

  useEffect(() => {
    if (!feed || !templateId) return;
    const topics = [`template:${templateId}`, ...(jobId ? [`job:${jobId}`] : [])].join(",");
    const source = new EventSource(`/api/events?topics=${encodeURIComponent(topics)}`);

    const onOpen = (): void => void feed.connected();
    const onJob = (e: MessageEvent<string>): void => {
      const view = frameData<AgentJobView>(e);
      if (view && typeof view.id === "string") void feed.jobChanged(view);
    };
    const onMessage = (e: MessageEvent<string>): void => {
      const data = frameData<{ jobId: string; seq: number }>(e);
      if (data && typeof data.seq === "number") void feed.messageArrived(data.jobId, data.seq);
    };

    source.addEventListener("open", onOpen);
    source.addEventListener("agent-job", onJob as EventListener);
    source.addEventListener("agent-message", onMessage as EventListener);
    return () => source.close();
  }, [feed, templateId, jobId]);

  return { state, feed };
}

/** 帧的外层是 `{ topic, data }`（server/src/lib/sse.ts） */
function frameData<T>(e: MessageEvent<string>): T | null {
  try {
    const frame = JSON.parse(e.data) as { data?: T };
    return frame.data ?? null;
  } catch {
    return null;
  }
}

function noopSubscribe(): () => void {
  return () => {};
}

function idleState(): FeedState {
  return IDLE;
}
