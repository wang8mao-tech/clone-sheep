import { db } from "../db/index.js";

/**
 * 批次的钱（REQ-006 闸门、SCREEN-006 组头）：已花现算、限额取提交时定下的。闸门与 ④ 变体的组头用同一份算法，
 * 界面上的数字就是闸门看的数字。从 estimate-run.ts 拆出来守 300 行上限
 */

interface Limits {
  batch_limit_usd: number;
}

/**
 * 批次「已花」：现算，不靠谁去累加一个字段——两部分相加：
 * 1. 批次里其它出片单位最新一次估价里已放行的（auto 或人已确认）之和，作废 / 失败 / 排队待估的不算；
 * 2. 批次里所有已经提交给 hypit、却没出成（失败 / 取消）的 build 的估价——包括这条自己之前的尝试。
 *    「重试出片」会再花一次钱，旧的那次不能当没发生过（6.4 第三轮审查 M2，Task 7.2）。
 * build 拿不到实际金额（REQ-009），估价就是这次会花的钱
 */
export function batchSpentUsd(batchId: string, exceptProductionId: string): number {
  const attempts = db()
    .prepare(
      `SELECT COALESCE(SUM(b.estimate_usd), 0) AS spent
         FROM builds b JOIN productions p ON p.id = b.production_id
        WHERE p.batch_id = ? AND b.hypit_build_id IS NOT NULL AND b.status IN ('failed', 'cancelled')`,
    )
    .get(batchId) as { spent: number };
  const row = db()
    .prepare(
      `SELECT COALESCE(SUM(e.total_usd), 0) AS spent
         FROM productions p
         JOIN estimates e ON e.id = (
           SELECT id FROM estimates WHERE production_id = p.id ORDER BY created_at DESC, rowid DESC LIMIT 1
         )
        WHERE p.batch_id = ? AND p.id <> ? AND p.status NOT IN ('cancelled', 'failed')
          AND (e.decision = 'auto' OR e.confirmed_at IS NOT NULL)`,
    )
    .get(batchId, exceptProductionId) as { spent: number };
  return row.spent + attempts.spent;
}

/** ④ 变体组头的「已花 / 限额」：和闸门同一个算法、同一个限额来源，界面上的数字就是闸门看的数字 */
export function batchBudget(batchId: string): { limitUsd: number; spentUsd: number } {
  return { limitUsd: batchLimitOf(batchId), spentUsd: batchSpentUsd(batchId, "") };
}

/** 批次限额以提交时定下的 budget 为准（Spec FLOW-003 步骤 1），没定的用设置里的批次限额 */
export function batchLimitOf(batchId: string): number {
  const limits = db().prepare("SELECT batch_limit_usd FROM settings WHERE id = 1").get() as Limits;
  const batch = db().prepare("SELECT budget_usd FROM batches WHERE id = ?").get(batchId) as
    { budget_usd: number } | undefined;
  return batch && batch.budget_usd > 0 ? batch.budget_usd : limits.batch_limit_usd;
}
