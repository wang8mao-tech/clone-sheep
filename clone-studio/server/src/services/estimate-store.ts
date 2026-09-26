import { db } from "../db/index.js";
import type { Estimate, EstimateLine } from "./estimate.js";
import type { GateReason } from "./gate.js";

/** estimates 表的读侧与估价记录的形状（REQ-006）。写侧与编排在 estimate-run.ts */

export interface EstimateRecord {
  id: string;
  productionId: string;
  kind: Estimate["kind"];
  totalUsd: number | null;
  lines: EstimateLine[];
  /** blocked 的原因 */
  reason: string | null;
  decision: "auto" | "confirm" | "blocked";
  reasons: GateReason[];
  confirmedAt: string | null;
  /** plan / pricing 本身没跑起来时的原文（也按拿不到处理） */
  error: string | null;
  /** pricing 给的价格页链接，按能力去重 */
  pricingUrls: string[];
  createdAt: string;
}

export function pricingUrlsOf(lines: EstimateLine[]): string[] {
  return [...new Set(lines.map((l) => l.pricingUrl).filter((u): u is string => Boolean(u)))];
}

export class EstimateError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EstimateError";
  }
}

interface EstimateRow {
  id: string;
  production_id: string;
  kind: Estimate["kind"];
  total_usd: number | null;
  lines_json: string;
  reason: string | null;
  decision: EstimateRecord["decision"];
  reasons_json: string;
  confirmed_at: string | null;
  error_text: string | null;
  created_at: string;
}

/** 出片单位最近一次的估价结论；还没估过是 undefined */
export function currentEstimate(productionId: string): EstimateRecord | undefined {
  const row = db()
    .prepare("SELECT * FROM estimates WHERE production_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(productionId) as EstimateRow | undefined;
  if (!row) return undefined;
  const lines = JSON.parse(row.lines_json) as EstimateLine[];
  return {
    id: row.id,
    productionId: row.production_id,
    kind: row.kind,
    totalUsd: row.total_usd,
    lines,
    reason: row.reason,
    decision: row.decision,
    reasons: JSON.parse(row.reasons_json) as GateReason[],
    confirmedAt: row.confirmed_at,
    error: row.error_text,
    pricingUrls: pricingUrlsOf(lines),
    createdAt: row.created_at,
  };
}
