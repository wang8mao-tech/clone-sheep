import { Badge } from "./ui/Badge.js";

/**
 * 「含未知」（Phase 10 交接，Task 11.4）：合计里有 Agent 任务用的是没填单价的模型档案，那部分花费算不出、
 * 没算进这个数。跟在「估」后面，⑤ 成片卡片、模板页头、客户页累计三处共用；花费明细自己有一行说明。
 */
export function CostUnknownBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return <Badge title="有 Agent 任务用的模型档案没填单价，那部分花费算不出，不在这个数里">含未知</Badge>;
}
