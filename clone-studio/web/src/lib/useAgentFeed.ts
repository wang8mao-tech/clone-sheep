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
  gate: null,
};

/** 同一条 SSE 上顺带转给页面的模板事件（server/src/services/clone.ts 的 `clone`） */
const TEMPLATE_EVENTS = ["clone", "estimate", "build", "review", "variants", "outputs"] as const;

/**
 * 模板的 Agent 任务 + 消息流。取数顺序见 AgentFeed 的说明：
 * 先开 SSE，`open`（含每一次自动重连）之后才去拉，所以快照和补齐永远发生在订阅之后。
 *
 * 知道任务 id 之后主题里加上 `job:<id>`，EventSource 随之重建——重建后的 `open` 走
 * 「对 seq 补齐」，快照和新订阅之间产生的消息由它补上。
 */
export function useAgentFeed(
  templateId: string | undefined,
  /** 在 007 素材审核里：跟这条变体的任务（Design-Brief §2.3，Task 9.3）；页面事件仍走模板主题 */
  variantId?: string,
): { state: FeedState; feed: AgentFeed | null } {
  const feed = useMemo(
    () => (templateId ? new AgentFeed(templateId, agentApi, variantId ?? null) : null),
    [templateId, variantId],
  );
  const state = useSyncExternalStore(feed?.subscribe ?? noopSubscribe, feed?.getState ?? idleState);
  const jobId = state.job?.id;

  useEffect(() => {
    if (!feed || !templateId) return;
    // 变体任务的 agent-job 事件推在 production:<id> 上（server agent-service notify），重跑出的新任务靠它换过去
    const topics = [
      `template:${templateId}`,
      ...(variantId ? [`production:${variantId}`] : []),
      ...(jobId ? [`job:${jobId}`] : []),
    ].join(",");
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

    // 模板主题上的其它事件走同一条连接（server 往 template:<id> 推的 clone 等）
    const onTemplateEvent = (e: MessageEvent<string>): void => feed.templateEvent(e.type, frameData(e));

    source.addEventListener("open", onOpen);
    source.addEventListener("agent-job", onJob as EventListener);
    source.addEventListener("agent-message", onMessage as EventListener);
    for (const name of TEMPLATE_EVENTS) source.addEventListener(name, onTemplateEvent as EventListener);
    return () => source.close();
  }, [feed, templateId, variantId, jobId]);

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
