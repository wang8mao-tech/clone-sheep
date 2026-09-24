import { db } from "../db/index.js";
import type { BuildProgress } from "./build-progress.js";

/**
 * builds 台账的读写与对外形状（REQ-009）。只依赖库：路由的复刻快照、删除流程都要看它，
 * 不能为此把执行器（连带 hypit 子进程）拉进依赖图。
 */

export interface BuildView {
  id: string;
  productionId: string;
  status: "running" | "done" | "failed" | "cancelled";
  hypitBuildId: string | null;
  estimateUsd: number | null;
  receiptId: string | null;
  receiptUrl: string | null;
  errorCode: string | null;
  /** hypit 的 failure 原文，一整段，界面原样展示 */
  errorMessage: string | null;
  outputPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  /** 失败时记下的机器状态（可用内存）与最后一条进度 */
  context: BuildContext | null;
  /** 运行中的实时进度（只在内存里） */
  progress: BuildProgress | null;
  /** `hypit activity --watch --jsonl` 报的 Runtime 侧阶段计数（进度行没到时也有），只在运行中有 */
  activity: { phases: Record<string, number>; requests: { total: number; completed: number } | null } | null;
}

export interface BuildContext {
  freeMemBytes: number;
  totalMemBytes: number;
  lastProgress: string | null;
}

export interface BuildRow {
  id: string;
  production_id: string;
  status: BuildView["status"];
  hypit_build_id: string | null;
  estimate_usd: number | null;
  receipt_id: string | null;
  receipt_url: string | null;
  error_code: string | null;
  error_message: string | null;
  output_path: string | null;
  context_json: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface ProductionRow {
  id: string;
  template_id: string;
  kind: "replica" | "variant";
  version: number;
  run_path: string | null;
  status: string;
}

export class BuildError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BuildError";
  }
}

export function readBuildRow(id: string): BuildRow | undefined {
  return db().prepare("SELECT * FROM builds WHERE id = ?").get(id) as BuildRow | undefined;
}

export function latestBuildRow(productionId: string): BuildRow | undefined {
  return db()
    .prepare("SELECT * FROM builds WHERE production_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(productionId) as BuildRow | undefined;
}

/** 这条出片单位出过片没有（估价 blocked 的失败与出片失败靠这个分：前者可重估，后者走重试出片） */
export function hasBuild(productionId: string): boolean {
  return db().prepare("SELECT 1 FROM builds WHERE production_id = ? LIMIT 1").get(productionId) !== undefined;
}

export function readProduction(productionId: string): ProductionRow | undefined {
  return db()
    .prepare("SELECT id, template_id, kind, version, run_path, status FROM productions WHERE id = ?")
    .get(productionId) as ProductionRow | undefined;
}

export function setProductionStatus(
  productionId: string,
  status: string,
  at = new Date().toISOString(),
  options: { unlessCancelled?: boolean } = {},
): void {
  const guard = options.unlessCancelled ? " AND status <> 'cancelled'" : "";
  db().prepare(`UPDATE productions SET status = ?, updated_at = ? WHERE id = ?${guard}`).run(status, at, productionId);
}

const BUILD_COLUMNS = new Set([
  "status",
  "hypit_build_id",
  "receipt_id",
  "receipt_url",
  "error_code",
  "error_message",
  "output_path",
  "context_json",
  "ended_at",
]);

/** 只改给出的列（hypit_build_id 在提交后就先落，最终结果再补一遍）；列名对着白名单，不拼外来键 */
export function updateBuild(id: string, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  for (const k of keys) if (!BUILD_COLUMNS.has(k)) throw new Error(`builds 没有这一列：${k}`);
  db()
    .prepare(`UPDATE builds SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), id);
}

export function presentBuild(
  row: BuildRow,
  live: { progress: BuildProgress | null; activity: BuildView["activity"] } | null,
): BuildView {
  return {
    id: row.id,
    productionId: row.production_id,
    status: row.status,
    hypitBuildId: row.hypit_build_id,
    estimateUsd: row.estimate_usd,
    receiptId: row.receipt_id,
    receiptUrl: row.receipt_url,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    outputPath: row.output_path,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    context: row.context_json ? (JSON.parse(row.context_json) as BuildContext) : null,
    progress: live?.progress ?? null,
    activity: live?.activity ?? null,
  };
}
