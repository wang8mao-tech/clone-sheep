import { db } from "../db/index.js";
import { RERUNNABLE } from "./variant-review.js";

/** 出片单位的 Agent 任务，此刻在这条出片单位上能做什么（抽屉与 CMP-009 横条只给真能做的，Task 9.3） */
export interface OwnerGate {
  /** 所属模板：007 的 ?variant= 是别的模板的，前端当没有任务 */
  templateId: string;
  /** 「继续」：Agent 那一段停下（失败 / 熔断 / 中断）、还没交给出片（同 ④ 队列行的规则；已作废的不行） */
  continue: boolean;
  /** 「重跑」：同 rerunVariant 接受的状态（已作废的不行） */
  rerun: boolean;
}

export function ownerGate(productionId: string): OwnerGate | null {
  const row = db()
    .prepare("SELECT template_id, kind, run_path, status FROM productions WHERE id = ?")
    .get(productionId) as { template_id: string; kind: string; run_path: string | null; status: string } | undefined;
  if (!row) return null;
  const variant = row.kind === "variant";
  return {
    templateId: row.template_id,
    continue: variant && ["failed", "tripped", "interrupted"].includes(row.status) && row.run_path === null,
    rerun: variant && RERUNNABLE.includes(row.status),
  };
}
