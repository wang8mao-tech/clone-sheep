import { createContext, useContext } from "react";
import type { AgentFeed, FeedState } from "./agent-feed.js";

export interface TemplateAgent {
  templateId: string | undefined;
  state: FeedState;
  feed: AgentFeed | null;
}

/** 当前模板的 Agent 任务与消息流，由 AgentFeedProvider 提供 */
export const TemplateAgentContext = createContext<TemplateAgent | null>(null);

export function useTemplateAgent(): TemplateAgent {
  const value = useContext(TemplateAgentContext);
  if (!value) throw new Error("useTemplateAgent 必须在 AgentFeedProvider 里面用");
  return value;
}
