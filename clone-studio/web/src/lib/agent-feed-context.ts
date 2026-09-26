import { createContext, useContext } from "react";
import type { AgentFeed, FeedState } from "./agent-feed.js";

export interface TemplateAgent {
  templateId: string | undefined;
  /** 在 007 素材审核里时是所选变体：抽屉与熔断横条看它的任务（Task 9.3） */
  variantId?: string | undefined;
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
