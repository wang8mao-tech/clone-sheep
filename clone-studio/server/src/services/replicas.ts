import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";

/**
 * 复刻片（productions kind=replica）的读写。只依赖库：证据流水线换参考视频时要作废旧复刻片，
 * 不能为此把复刻编排（连带 Agent SDK）拉进它的依赖图。
 */

export interface ReplicaRow {
  id: string;
  template_id: string;
  version: number;
  run_path: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/** 这个模板有出片单位正在渲染 */
export function isBuilding(templateId: string): boolean {
  return (
    db().prepare("SELECT 1 FROM productions WHERE template_id = ? AND status = 'building' LIMIT 1").get(templateId) !==
    undefined
  );
}

/** 模板当前的复刻片（最新版本，已作废的不算）。打回重做会有 v2、v3，Phase 7 管版本切换 */
export function latestReplica(templateId: string): ReplicaRow | undefined {
  return db()
    .prepare(
      `SELECT id, template_id, version, run_path, status, created_at, updated_at FROM productions
        WHERE template_id = ? AND kind = 'replica' AND status <> 'cancelled' ORDER BY version DESC LIMIT 1`,
    )
    .get(templateId) as ReplicaRow | undefined;
}

/**
 * 作废还没开始出片的复刻片：它们是按旧参考视频 / 上一轮稿子建的，留着会被估价、自动出片当成现在的。
 * 渲染中与已出片的不动（渲染中的那条由 Task 6.4 拒绝换参考视频来保护）。
 */
export function cancelOpenReplicas(templateId: string): number {
  return db()
    .prepare(
      `UPDATE productions SET status = 'cancelled', updated_at = ?
        WHERE template_id = ? AND kind = 'replica' AND status IN ('queued', 'awaiting_cost_confirm', 'failed')`,
    )
    .run(new Date().toISOString(), templateId).changes;
}

/**
 * 判据通过：确保有一条排队中的复刻片等估价。已经有一条还没出片的就复用它（「继续」后再次完成
 * 不该多出一条）；已出片的（打回后重做）建下一版。版本号跟着全部历史走，作废的也占号。
 * 失败的（估价 blocked、或出片失败）是按上一版稿子来的：作废它、建下一版，重新走估价与闸门，
 * 不复用（复用会留在 failed 里，永远不再估价 / 出片）。
 */
export function ensureReplica(templateId: string): void {
  const current = latestReplica(templateId);
  if (current && current.status !== "done" && current.status !== "failed") return;
  if (current?.status === "failed") {
    db()
      .prepare("UPDATE productions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'failed'")
      .run(new Date().toISOString(), current.id);
  }
  const max = db()
    .prepare("SELECT MAX(version) AS v FROM productions WHERE template_id = ? AND kind = 'replica'")
    .get(templateId) as { v: number | null };
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO productions (id, template_id, kind, version, run_path, status, created_at, updated_at)
       VALUES (?, ?, 'replica', ?, 'reference.svrun', 'queued', ?, ?)`,
    )
    .run(randomUUID(), templateId, (max.v ?? 0) + 1, now, now);
}
