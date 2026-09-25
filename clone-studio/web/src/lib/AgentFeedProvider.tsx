import type { ReactNode } from "react";
import { TemplateAgentContext } from "./agent-feed-context.js";
import { useAgentFeed } from "./useAgentFeed.js";

/**
 * 当前模板的 Agent 任务与消息流，全页只有一份：右侧抽屉和工作区的熔断 / 中断横条（CMP-009）
 * 看的是同一个任务。各拉一份的话，横条上点了「继续」，抽屉要等下一次事件才知道，
 * 两边还会各开一条 SSE。挂在外壳上（抽屉在路由出口之外），模板 id 由外壳匹配出来传进来。
 */
export function AgentFeedProvider({
  templateId,
  variantId,
  children,
}: {
  templateId: string | undefined;
  /** 007 素材审核里所选的变体：抽屉与熔断横条跟它的任务（Design-Brief §2.3「抽屉跟随当前所选对象」） */
  variantId?: string | undefined;
  children: ReactNode;
}) {
  const { state, feed } = useAgentFeed(templateId, variantId);
  return (
    <TemplateAgentContext.Provider value={{ templateId, variantId, state, feed }}>
      {children}
    </TemplateAgentContext.Provider>
  );
}
