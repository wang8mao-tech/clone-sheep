import { db } from "../db/index.js";
import { ArchiveError } from "./archive.js";

/** ⑤ 成片库的行读取与名称（REQ-007）。只依赖库：列表、花费明细、打包、删除都要它，互相不牵依赖 */

export interface ProductionOutputRow {
  id: string;
  template_id: string;
  kind: "replica" | "variant";
  name: string | null;
  version: number;
  run_path: string | null;
  status: string;
  output_deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export const OUTPUT_COLUMNS =
  "id, template_id, kind, name, version, run_path, status, output_deleted_at, created_at, updated_at";

export function readOutputRow(id: string): ProductionOutputRow | undefined {
  return db().prepare(`SELECT ${OUTPUT_COLUMNS} FROM productions WHERE id = ?`).get(id) as
    ProductionOutputRow | undefined;
}

/** 成片单位存在且没被删过成片 */
export function requireOutput(id: string): ProductionOutputRow {
  const row = readOutputRow(id);
  if (!row || row.output_deleted_at) throw new ArchiveError("这条成片不存在", "OUTPUT_NOT_FOUND", 404);
  return row;
}

/** 名称：用户起的 / 变体默认的 brief 前 20 字；复刻片默认「复刻片 vN」 */
export function outputName(row: Pick<ProductionOutputRow, "kind" | "name" | "version">): string {
  return row.name ?? (row.kind === "replica" ? `复刻片 v${row.version}` : `变体 v${row.version}`);
}

/**
 * 网格收哪些：出过片的（有 build，含失败、被作废的），加上已交给估价与出片、还没作废的——
 * 复刻片过了判据就有运行文件，变体要素材通过之后才有（9.1 第三轮审查 S1-M1：排队、待确认的复刻片也列）
 */
export const LISTED = `(EXISTS (SELECT 1 FROM builds b WHERE b.production_id = p.id)
                 OR (p.run_path IS NOT NULL AND p.status <> 'cancelled'))`;

/** 网格里有它：改名、删除都只对网格里的成片（REQ-007；9.1 第四轮审查 S1-L1） */
export function isListed(id: string): boolean {
  return (
    db().prepare(`SELECT 1 FROM productions p WHERE p.id = ? AND p.output_deleted_at IS NULL AND ${LISTED}`).get(id) !==
    undefined
  );
}
