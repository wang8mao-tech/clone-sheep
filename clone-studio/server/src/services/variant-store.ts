import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { SourceAsset } from "./variant-files.js";

/**
 * 变体与素材的库读写（REQ-005）。只依赖库本身：Agent 调度器（重跑清产物）、编排、路由都用它，
 * 不把 Agent SDK 或 hypit 调用拉进彼此的依赖图。
 */

export interface VariantRow {
  id: string;
  template_id: string;
  batch_id: string | null;
  brief: string | null;
  name: string | null;
  run_path: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AssetRow {
  id: string;
  production_id: string;
  label: string | null;
  file_path: string | null;
  source_url: string | null;
  replaced_by_user: number;
  is_gap: number;
  created_at: string;
}

export function findVariant(id: string): VariantRow | undefined {
  return db()
    .prepare(
      `SELECT id, template_id, batch_id, brief, name, run_path, status, created_at, updated_at
         FROM productions WHERE id = ? AND kind = 'variant'`,
    )
    .get(id) as VariantRow | undefined;
}

/** 出片单位属于哪个模板（任何 kind）：Agent 任务按它找工作目录 */
export function productionTemplateId(id: string): string | undefined {
  const row = db().prepare("SELECT template_id FROM productions WHERE id = ?").get(id) as
    { template_id: string } | undefined;
  return row?.template_id;
}

export function listAssets(productionId: string): AssetRow[] {
  return db()
    .prepare("SELECT * FROM assets WHERE production_id = ? ORDER BY file_path, created_at")
    .all(productionId) as AssetRow[];
}

/** 用户替换过的图（相对变体目录）：重跑时原样保留 */
export function userReplacedFiles(productionId: string): string[] {
  const rows = db()
    .prepare("SELECT file_path FROM assets WHERE production_id = ? AND replaced_by_user = 1 AND file_path IS NOT NULL")
    .all(productionId) as Array<{ file_path: string }>;
  return rows.map((r) => r.file_path);
}

/**
 * 判据通过后按 SOURCES.json 重建素材行。之前人替换过、这次仍列着的文件保留「已替换」标记：
 * 打回或重跑之后 Agent 把用户的图照原路径写回清单，界面上不能把它显示成 Agent 抓的
 */
export function replaceAssets(
  productionId: string,
  sources: readonly SourceAsset[],
  keepReplaced: readonly string[],
): void {
  const replaced = new Set(keepReplaced);
  const now = new Date().toISOString();
  const insert = db().prepare(
    `INSERT INTO assets (id, production_id, label, file_path, source_url, replaced_by_user, is_gap, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db().prepare("DELETE FROM assets WHERE production_id = ?").run(productionId);
  for (const s of sources) {
    const userOwned = replaced.has(s.file);
    insert.run(
      randomUUID(),
      productionId,
      s.label,
      s.file,
      s.sourceUrl,
      userOwned ? 1 : 0,
      userOwned ? 0 : s.gap ? 1 : 0,
      now,
    );
  }
}

export function setVariantStatus(id: string, status: string, onlyFrom?: readonly string[]): boolean {
  const now = new Date().toISOString();
  if (!onlyFrom) {
    return (
      db().prepare("UPDATE productions SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id).changes > 0
    );
  }
  const marks = onlyFrom.map(() => "?").join(", ");
  return (
    db()
      .prepare(`UPDATE productions SET status = ?, updated_at = ? WHERE id = ? AND status IN (${marks})`)
      .run(status, now, id, ...onlyFrom).changes > 0
  );
}
