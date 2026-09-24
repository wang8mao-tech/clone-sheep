import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { HypitError, runHypit } from "../hypit/cli.js";
import { PROFILE_FILENAME, refreshRuntimeProfile } from "../hypit/workspace.js";
import { credentialEnv } from "../lib/secrets.js";
import { notify } from "../agent/agent-service.js";
import { requireTemplate, workspaceServices } from "./archive.js";
import { estimateFromPlan, type Estimate } from "./estimate.js";
import { decideGate, type GateDecision, type GateReason } from "./gate.js";
import { listRates } from "./rates.js";
import { pumpBuilds } from "./build-run.js";
import { currentEstimate, EstimateError, pricingUrlsOf, type EstimateRecord } from "./estimate-store.js";

export { currentEstimate, EstimateError, type EstimateRecord } from "./estimate-store.js";

/**
 * 估价与花钱闸门的编排（REQ-006、FLOW-002 步骤 4-5 / FLOW-003 步骤 5）。
 *
 * 出片单位排好队 → 重写 Runtime Profile → `hypit plan --json`（估价的数据来源）+ `hypit pricing --json`
 * （只读联网、不花钱，价格页原文给人核对费率表）→ 按费率表算估价 → 闸门判定 → 落库、改状态：
 * 限额内 `auto`（等 6.4 的出片执行器接手）；超限 / 拿不到 `confirm`（待确认花费，人点确认才出片）；
 * 未解析请求 / preflight 没过 `blocked`（不出片，标失败并写明原因）。
 */

interface ProductionRow {
  id: string;
  template_id: string;
  batch_id: string | null;
  run_path: string | null;
  status: string;
  created_at: string;
}

/** 能估价 / 能被估价结论改状态的出片单位状态。已取消、渲染中、已出片的都不动 */
const ESTIMABLE: readonly string[] = ["queued", "awaiting_cost_confirm", "failed"];

/** 正在估的：同一条不并发跑两遍 plan（启动补估 + 判据触发可能撞在一起） */
const inFlight = new Set<string>();

interface Limits {
  per_item_limit_usd: number;
  batch_limit_usd: number;
}

const PLAN_TIMEOUT_MS = 3 * 60_000;

/** 跑一次估价并过闸门；结论落库。plan 跑不起来也落一条（拿不到 → 等确认），不让出片单位卡在排队里 */
export async function estimateProduction(productionId: string): Promise<EstimateRecord> {
  if (inFlight.has(productionId)) throw new EstimateError("这条正在估价", "ESTIMATE_IN_FLIGHT", 409);
  inFlight.add(productionId);
  try {
    return await estimateOnce(productionId);
  } finally {
    inFlight.delete(productionId);
  }
}

async function estimateOnce(productionId: string): Promise<EstimateRecord> {
  const production = db()
    .prepare("SELECT id, template_id, batch_id, run_path, status, created_at FROM productions WHERE id = ?")
    .get(productionId) as ProductionRow | undefined;
  if (!production) throw new Error(`出片单位不存在：${productionId}`);
  if (!ESTIMABLE.includes(production.status)) {
    throw new EstimateError(`这条现在是「${production.status}」，不估价`, "NOT_ESTIMABLE", 409);
  }
  // 「失败」有两种：估价 blocked（可重估）和出片失败（有 build 记录，走「重试出片」，不能靠重估绕过去再花钱）
  if (production.status === "failed" && hasBuild(productionId)) {
    throw new EstimateError("这条是出片失败，用「重试出片」，不重新估价", "NOT_ESTIMABLE", 409);
  }
  const template = requireTemplate(production.template_id);
  const dir = template.workspace_path;
  if (!dir) throw new Error(`模板还没有工作目录：${template.id}`);
  if (!production.run_path) throw new Error(`出片单位没有 run 文件：${productionId}`);

  // 出片前不信任 Agent 会话之后留下的 Runtime Profile（REQ-003），估价用的 plan 也按重写后的算
  refreshRuntimeProfile(dir, workspaceServices());
  const subject = { kind: "production", id: productionId };
  const common = { cwd: dir, subject, timeoutMs: PLAN_TIMEOUT_MS, env: credentialEnv() };

  let planJson: unknown = null;
  let pricingJson: unknown;
  let error: string | null = null;
  let estimate: Estimate;
  try {
    const plan = await runHypit(
      ["plan", production.run_path, "--runtime", PROFILE_FILENAME, "--workspace", dir, "--json"],
      common,
    );
    planJson = plan.json;
    estimate = estimateFromPlan(plan.json, listRates());
  } catch (e) {
    error = e instanceof HypitError ? [e.message, e.help, e.raw].filter(Boolean).join("\n") : String(e);
    estimate = { kind: "ok", totalUsd: null, lines: [], providerRequestCount: 0 };
  }
  // pricing 是只读的联网查询，不花钱；失败不影响估价，只是少了价格页原文
  try {
    const pricing = await runHypit(
      ["pricing", production.run_path, "--runtime", PROFILE_FILENAME, "--workspace", dir, "--json"],
      common,
    );
    pricingJson = pricing.json;
  } catch {
    pricingJson = null;
  }

  const decision: GateDecision | null =
    estimate.kind === "ok" ? decideGate(gateInput(production, estimate.totalUsd)) : null;
  const record = saveEstimate({ production, planJson, pricingJson, estimate, decision, error });
  // 估的这几分钟里人可能换了参考视频（复刻片已作废）：结论照记，但状态不能把「已取消」拉回来
  const applied = applyDecision(production, record);
  notify(`template:${production.template_id}`, "estimate", {
    productionId,
    estimateId: record.id,
    decision: applied ? record.decision : null,
  });
  // 限额内自动放行：交给出片执行器（AC-017「无需点击自动进入渲染中」）
  if (applied && record.decision === "auto") pumpBuilds();
  return record;
}

function hasBuild(productionId: string): boolean {
  return db().prepare("SELECT 1 FROM builds WHERE production_id = ? LIMIT 1").get(productionId) !== undefined;
}

/**
 * 批次「已花」：现算，不靠谁去累加一个字段——批次里其它出片单位最新一次估价里已放行的（auto 或人已确认）
 * 之和，作废 / 失败 / 排队待估的不算。build 拿不到实际金额（REQ-009），放行的估价就是这条会花的钱
 */
function batchSpentUsd(batchId: string, exceptProductionId: string): number {
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
  return row.spent;
}

function gateInput(production: ProductionRow, estimateUsd: number | null) {
  const limits = db().prepare("SELECT per_item_limit_usd, batch_limit_usd FROM settings WHERE id = 1").get() as Limits;
  if (!production.batch_id) return { estimateUsd, perItemLimitUsd: limits.per_item_limit_usd };
  // 批次限额以提交时定下的 budget 为准（Spec FLOW-003 步骤 1），没定的用设置里的批次限额
  const batch = db().prepare("SELECT budget_usd FROM batches WHERE id = ?").get(production.batch_id) as
    { budget_usd: number } | undefined;
  const batchLimit = batch && batch.budget_usd > 0 ? batch.budget_usd : limits.batch_limit_usd;
  // 批次里**更早**的一条还停在「待确认花费」、且是因为批次限额停的：之后的全部停（AC-019）。
  // 只看仍在等确认的（已取消 / 已确认 / 失败的不再挡后面），只看比这条早的（重估更早那条时后面的挡不到它）
  const halted = db()
    .prepare(
      `SELECT 1 FROM estimates e JOIN productions p ON p.id = e.production_id
        WHERE p.batch_id = ? AND p.id <> ? AND p.created_at < ? AND p.status = 'awaiting_cost_confirm'
          AND e.confirmed_at IS NULL AND e.decision = 'confirm'
          AND (e.reasons_json LIKE '%over_batch_limit%' OR e.reasons_json LIKE '%batch_halted%')
          AND e.id = (SELECT id FROM estimates WHERE production_id = p.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
        LIMIT 1`,
    )
    .get(production.batch_id, production.id, production.created_at);
  return {
    estimateUsd,
    perItemLimitUsd: limits.per_item_limit_usd,
    batch: {
      limitUsd: batchLimit,
      spentUsd: batchSpentUsd(production.batch_id, production.id),
      halted: halted !== undefined,
    },
  };
}

function saveEstimate(input: {
  production: ProductionRow;
  planJson: unknown;
  pricingJson: unknown;
  estimate: Estimate;
  decision: GateDecision | null;
  error: string | null;
}): EstimateRecord {
  const { estimate, decision } = input;
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const kind = estimate.kind;
  const totalUsd = estimate.kind === "ok" ? estimate.totalUsd : null;
  const reason = estimate.kind === "blocked" ? estimate.reason : null;
  const verdict: EstimateRecord["decision"] = decision === null ? "blocked" : decision.pass ? "auto" : "confirm";
  const reasons: GateReason[] = decision && !decision.pass ? decision.reasons : [];
  db()
    .prepare(
      `INSERT INTO estimates (id, production_id, plan_json, pricing_json, kind, total_usd, lines_json, reason, decision,
                              reasons_json, confirmed_at, error_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      input.production.id,
      input.planJson === null ? null : JSON.stringify(input.planJson),
      input.pricingJson === null ? null : JSON.stringify(input.pricingJson),
      kind,
      totalUsd,
      JSON.stringify(estimate.lines),
      reason,
      verdict,
      JSON.stringify(reasons),
      input.error,
      createdAt,
    );
  return {
    id,
    productionId: input.production.id,
    kind,
    totalUsd,
    lines: estimate.lines,
    reason,
    decision: verdict,
    reasons,
    confirmedAt: null,
    error: input.error,
    pricingUrls: pricingUrlsOf(estimate.lines),
    createdAt,
  };
}

/**
 * 闸门结论 → 出片单位的状态。auto 留在排队等出片执行器（6.4）；confirm 待确认花费；blocked 失败。
 * 只改仍处于可估价状态的：估价期间被作废（cancelled）或已经开始出片的，一律不动，返回 false
 */
function applyDecision(production: ProductionRow, record: EstimateRecord): boolean {
  const status =
    record.decision === "auto" ? "queued" : record.decision === "confirm" ? "awaiting_cost_confirm" : "failed";
  const changes = db()
    .prepare(
      `UPDATE productions SET status = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'awaiting_cost_confirm', 'failed')`,
    )
    .run(status, new Date().toISOString(), production.id).changes;
  return changes > 0;
}

/** 人点「确认出片 $x.xx」：记下确认时刻，出片单位回到排队等执行器 */
export function confirmCost(productionId: string): EstimateRecord {
  const current = currentEstimate(productionId);
  if (!current) throw new EstimateError("这条还没有估价，不能确认", "NO_ESTIMATE", 409);
  if (current.decision !== "confirm") throw new EstimateError("这条不需要确认花费", "NOT_AWAITING_CONFIRM", 409);
  if (current.confirmedAt) return current;
  const production = db().prepare("SELECT template_id, status FROM productions WHERE id = ?").get(productionId) as
    { template_id: string; status: string } | undefined;
  // 估价说要确认，但出片单位已经不在「待确认花费」（被作废、或旧标签页的重复点击）：不能把它拉回排队
  if (production?.status !== "awaiting_cost_confirm") {
    throw new EstimateError("这条已经不在待确认花费状态", "NOT_AWAITING_CONFIRM", 409);
  }
  const now = new Date().toISOString();
  db().prepare("UPDATE estimates SET confirmed_at = ? WHERE id = ?").run(now, current.id);
  db()
    .prepare(
      "UPDATE productions SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'awaiting_cost_confirm'",
    )
    .run(now, productionId);
  notify(`template:${production.template_id}`, "estimate", { productionId, estimateId: current.id, decision: "auto" });
  // 人确认了：出片（AC-018「点确认后才开始 build」）
  pumpBuilds();
  return { ...current, confirmedAt: now };
}

/**
 * 判据通过建出复刻片之后（只看那个模板的）、或重启时（全部）：排队中还没估过价、也不在估的出片单位。
 * 估价不花钱，可以自动
 */
export function unestimatedQueued(templateId?: string): string[] {
  const rows = db()
    .prepare(
      `SELECT p.id FROM productions p
        WHERE p.status = 'queued' AND p.run_path IS NOT NULL AND (? IS NULL OR p.template_id = ?)
          AND NOT EXISTS (SELECT 1 FROM estimates e WHERE e.production_id = p.id)`,
    )
    .all(templateId ?? null, templateId ?? null) as Array<{ id: string }>;
  return rows.map((r) => r.id).filter((id) => !inFlight.has(id));
}
