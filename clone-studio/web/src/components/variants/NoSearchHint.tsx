import { useQuery } from "@tanstack/react-query";
import { useTemplateAgent } from "../../lib/agent-feed-context.js";
import { profileApi, profileKeys } from "../../lib/model-profiles.js";

/**
 * 素材审核上的提示（REQ-010 MUST）：这条变体用的档案没有原生联网搜索，Agent 改用命令行与网页抓取找图，
 * 缺口可能偏多。按抽屉跟着的这条变体的任务认档案；档案删了认不出就不说（不猜）
 */
export function NoSearchHint() {
  const { state } = useTemplateAgent();
  const profiles = useQuery({ queryKey: profileKeys.list, queryFn: () => profileApi.list() });
  const id = state.job?.profileId;
  const profile = id ? profiles.data?.profiles.find((p) => p.id === id) : undefined;
  if (!profile || profile.supportsWebSearch) return null;
  return (
    <p role="note" className="text-caption text-warning">
      该模型无原生搜索，素材缺口可能偏多（「{profile.name}」没有原生联网搜索，Agent 改用命令行与网页抓取找图）。
    </p>
  );
}
