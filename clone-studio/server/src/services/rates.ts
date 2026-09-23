import { db } from "../db/index.js";
import type { Rate, RateUnit } from "./estimate.js";

/**
 * 费率表（REQ-006「估价来源」）：能力 → 单价，设置页可编辑。hypit 的 pricing 只给价格页链接不给数，
 * 估价全靠这张表；缺项一律按「估价拿不到」处理，所以表里没有的能力不会被静默算成 0。
 */

export interface RateRow extends Rate {
  id: number;
  note: string | null;
  updatedAt: string;
}

interface Row {
  id: number;
  capability: string;
  endpoint: string | null;
  unit: RateUnit;
  usd: number;
  note: string | null;
  updated_at: string;
}

function fromRow(r: Row): RateRow {
  return {
    id: r.id,
    capability: r.capability,
    endpoint: r.endpoint,
    unit: r.unit,
    usd: r.usd,
    note: r.note,
    updatedAt: r.updated_at,
  };
}

export function listRates(): RateRow[] {
  return (db().prepare("SELECT * FROM pricing_rates ORDER BY capability, endpoint").all() as Row[]).map(fromRow);
}

export interface RateInput {
  capability: string;
  endpoint?: string | null;
  unit: RateUnit;
  usd: number;
  note?: string | null;
}

/** 同一个「能力 + Endpoint」只有一行：再写就是改价 */
export function upsertRate(input: RateInput): RateRow {
  const now = new Date().toISOString();
  const endpoint = input.endpoint?.trim() || null;
  db()
    .prepare(
      `INSERT INTO pricing_rates (capability, endpoint, unit, usd, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (capability, IFNULL(endpoint, '')) DO UPDATE SET
         unit = excluded.unit, usd = excluded.usd, note = excluded.note, updated_at = excluded.updated_at`,
    )
    .run(input.capability.trim(), endpoint, input.unit, input.usd, input.note?.trim() || null, now, now);
  const row = db()
    .prepare("SELECT * FROM pricing_rates WHERE capability = ? AND IFNULL(endpoint, '') = ?")
    .get(input.capability.trim(), endpoint ?? "") as Row;
  return fromRow(row);
}

export function deleteRate(id: number): boolean {
  return db().prepare("DELETE FROM pricing_rates WHERE id = ?").run(id).changes > 0;
}
