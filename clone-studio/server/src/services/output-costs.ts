import { db } from "../db/index.js";
import { requireOutput, type ProductionOutputRow } from "./output-store.js";

/**
 * 花费明细 CMP-008（REQ-009、AC-024）：Agent 任务一张表、出片一张表，都标「估」，给合计。
 * Agent 花费是 SDK 自报的等价花费（"An estimate, not a billing statement"）；出片没有实际金额可取时用估价。
 * 复刻片的 Agent 会话挂在模板上、各版本共用：列出来但标 shared，不计入这一条的合计。
 * isEstimate / totalIsEstimate 只是提示：界面按 REQ-009 一律标「估」，不看它们分支（同模板页头、客户页）。
 */

export interface AgentCostLine {
  jobId: string;
  /** 用的模型档案名（快照，档案删了也在，REQ-010） */
  profileName: string | null;
  model: string | null;
  /** 花费口径：none = 兼容端点没填单价，花费算不出（界面写「未知」） */
  costBasis: string | null;
  status: string;
  /** 运行用时（等额度、排队不计） */
  elapsedMs: number;
  costUsd: number;
  isEstimate: boolean;
  shared: boolean;
  createdAt: string;
}

export interface BuildCostLine {
  buildId: string;
  hypitBuildId: string | null;
  channel: string | null;
  model: string | null;
  status: string;
  estimateUsd: number | null;
  actualUsd: number | null;
  /** 实际优先，没有就用估价；两样都没有是 0 */
  costUsd: number;
  isEstimate: boolean;
  receiptId: string | null;
  receiptUrl: string | null;
  createdAt: string;
}

export interface OutputCosts {
  productionId: string;
  agent: AgentCostLine[];
  builds: BuildCostLine[];
  /** 这一条自己的合计（不含共用的复刻会话） */
  totalUsd: number;
  totalIsEstimate: boolean;
}

interface JobRow {
  id: string;
  owner_kind: string;
  profile_name: string | null;
  model_id: string | null;
  cost_basis: string | null;
  status: string;
  run_elapsed_ms: number;
  run_started_at: string | null;
  cost_usd: number;
  cost_is_estimate: number;
  created_at: string;
}

interface BuildRow {
  id: string;
  hypit_build_id: string | null;
  video_channel: string | null;
  video_model: string | null;
  status: string;
  estimate_usd: number | null;
  actual_usd: number | null;
  receipt_id: string | null;
  receipt_url: string | null;
  created_at: string;
}

export function outputCosts(productionId: string, now = Date.now()): OutputCosts {
  return productionCosts(requireOutput(productionId), now);
}

/** 卡片合计与花费明细共用这一套：同一条成片两处的数与「估」不会对不上（9.1 审查 S2-5） */
export function productionCosts(
  row: Pick<ProductionOutputRow, "id" | "kind" | "template_id">,
  now = Date.now(),
): OutputCosts {
  const jobs = db()
    .prepare(
      `SELECT id, owner_kind, profile_name, model_id, cost_basis, status, run_elapsed_ms, run_started_at, cost_usd, cost_is_estimate, created_at
         FROM agent_jobs
        WHERE (owner_kind = 'production' AND owner_id = ?) OR (? = 'replica' AND owner_kind = 'template' AND owner_id = ?)
        ORDER BY created_at, rowid`,
    )
    .all(row.id, row.kind, row.template_id) as JobRow[];
  const builds = db()
    .prepare(
      `SELECT id, hypit_build_id, video_channel, video_model, status, estimate_usd, actual_usd, receipt_id, receipt_url, created_at
         FROM builds WHERE production_id = ? ORDER BY created_at, rowid`,
    )
    .all(row.id) as BuildRow[];

  const agent = jobs.map((j): AgentCostLine => ({
    jobId: j.id,
    profileName: j.profile_name,
    model: j.model_id,
    costBasis: j.cost_basis,
    status: j.status,
    elapsedMs:
      j.run_elapsed_ms +
      (j.status === "running" && j.run_started_at ? Math.max(0, now - Date.parse(j.run_started_at)) : 0),
    costUsd: j.cost_usd,
    isEstimate: j.cost_is_estimate === 1,
    shared: j.owner_kind === "template",
    createdAt: j.created_at,
  }));
  const buildLines = builds.map((b): BuildCostLine => ({
    buildId: b.id,
    hypitBuildId: b.hypit_build_id,
    channel: b.video_channel,
    model: b.video_model,
    status: b.status,
    estimateUsd: b.estimate_usd,
    actualUsd: b.actual_usd,
    costUsd: b.actual_usd ?? b.estimate_usd ?? 0,
    isEstimate: b.actual_usd === null,
    receiptId: b.receipt_id,
    receiptUrl: b.receipt_url,
    createdAt: b.created_at,
  }));
  const own = agent.filter((a) => !a.shared);
  return {
    productionId: row.id,
    agent,
    builds: buildLines,
    totalUsd: own.reduce((s, a) => s + a.costUsd, 0) + buildLines.reduce((s, b) => s + b.costUsd, 0),
    totalIsEstimate: own.some((a) => a.isEstimate) || buildLines.some((b) => b.isEstimate),
  };
}
