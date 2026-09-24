import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { db } from "../db/index.js";
import { agentScheduler, notify, present, type AgentJobView } from "../agent/agent-service.js";
import { usableModel } from "../agent/agent-models.js";
import { activeJobsOf, latestJobOf } from "../agent/job-store.js";
import { variantPrompt } from "../agent/prompts.js";
import { requireTemplate } from "./archive.js";
import { BATCH_MAX_DEFAULT, briefTitle, parseBriefs, type BriefLineError } from "./briefs.js";
import { BuildError, cancelBuild, latestBuild, type BuildView } from "./build-run.js";
import { batchBudget, currentEstimate, type EstimateRecord } from "./estimate-run.js";
import { EvidenceError } from "./evidence-types.js";
import { copyTemplateSources, variantDir } from "./variant-files.js";
import { findVariant, setVariantStatus, type VariantRow } from "./variant-store.js";

/**
 * 批量变体（REQ-005、FLOW-003 步骤 1-2）：一次提交一批 brief → 批次记录 + 每条一个变体出片单位，
 * 复制模板原稿到它自己的目录，入队变体 Agent 任务（并发由调度器的上限管，默认 2，AC-014）。
 * 之后的状态接力在 variant-flow.ts（任务 → 素材待审），素材审核之后交给估价闸门与出片执行器。
 */

export const BATCH_NOTE_MAX = 1000;

export class VariantError extends EvidenceError {
  constructor(
    code: string,
    message: string,
    status = 409,
    readonly detail?: unknown,
  ) {
    super(code, message, status);
  }
}

export interface SubmitInput {
  briefs: string;
  targetLanguage?: string | null;
  note?: string | null;
  modelId?: string | null;
  /** 这一批的限额；不给用设置里的批次限额 */
  budgetUsd?: number | null;
}

interface Limits {
  per_item_limit_usd: number;
  batch_limit_usd: number;
  batch_max_items: number;
}

function limits(): Limits {
  return db()
    .prepare("SELECT per_item_limit_usd, batch_limit_usd, batch_max_items FROM settings WHERE id = 1")
    .get() as Limits;
}

/** 提交一批。任何一项不合格都整批拒绝、不建任何记录（AC-016） */
export function submitBatch(templateId: string, input: SubmitInput): BatchView {
  const template = requireTemplate(templateId);
  if (template.status !== "approved") throw new VariantError("NOT_APPROVED", "先通过验货，才能批量出变体");
  if (!template.workspace_path) throw new VariantError("NO_WORKSPACE", "这个模板没有工作目录");
  const settings = limits();
  // 一批最多 20 条是 Spec 定死的（REQ-005 / FLOW-003）；设置里的条数只能往小调（8.1 第二轮审查 S1-L2）
  const max = Math.min(settings.batch_max_items > 0 ? settings.batch_max_items : BATCH_MAX_DEFAULT, BATCH_MAX_DEFAULT);
  const parsed = parseBriefs(input.briefs, max);
  if (!parsed.ok) {
    const detail: { count: number; lines: BriefLineError[] } = { count: parsed.count, lines: parsed.lines };
    throw new VariantError(`BRIEFS_${parsed.code}`, parsed.message, 400, detail);
  }
  const note = input.note?.trim() || null;
  if (note && [...note].length > BATCH_NOTE_MAX) {
    throw new VariantError("INVALID_NOTE", `批次备注最多 ${BATCH_NOTE_MAX} 字`, 400);
  }
  const modelId = input.modelId ?? null;
  if (!usableModel(modelId)) throw new VariantError("INVALID_MODEL", "这个模型不能用来写变体", 400);
  const budget = input.budgetUsd ?? settings.batch_limit_usd;
  if (!Number.isFinite(budget) || budget < settings.per_item_limit_usd || budget > 1000) {
    throw new VariantError("INVALID_BUDGET", `批次限额要在单条限额 $${settings.per_item_limit_usd} 到 $1000 之间`, 400);
  }
  // 模板导入时记了语言就用它；没记（老数据）时写一句会话看得懂的话，不塞一个占位词进提示（8.1 审查 LOW）
  const language = input.targetLanguage?.trim() || template.language || "和模板原片相同的语言";

  // 先把文件复制好再落库：复制失败就整批作罢，不留下没有原稿的变体
  const batchId = randomUUID();
  const ids = parsed.briefs.map(() => randomUUID());
  const dirs = ids.map((id) => variantDir(template.workspace_path as string, id));
  try {
    for (const dir of dirs) copyTemplateSources(template.workspace_path, dir);
  } catch (error) {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    throw new VariantError("COPY_FAILED", `复制模板原稿失败：${String(error)}`, 500);
  }

  const base = Date.now();
  const insertAll = db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO batches (id, template_id, note, target_language, budget_usd, spent_usd, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(batchId, templateId, note, input.targetLanguage?.trim() || null, budget, new Date(base).toISOString());
    const insert = db().prepare(
      `INSERT INTO productions (id, template_id, kind, batch_id, brief, name, version, run_path, status, created_at, updated_at)
       VALUES (?, ?, 'variant', ?, ?, ?, 1, NULL, 'queued', ?, ?)`,
    );
    parsed.briefs.forEach((brief, i) => {
      // 每条错开 1 毫秒：批次闸门按 created_at 判「更早的一条停了、后面的全停」（AC-019），同一时刻就分不出先后
      const at = new Date(base + i).toISOString();
      insert.run(ids[i], templateId, batchId, brief, briefTitle(brief), at, at);
    });
  });
  try {
    insertAll();
  } catch (error) {
    // 落库失败（库坏了、磁盘满）：复制出来的目录没人认领，清掉
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  const scheduler = agentScheduler();
  parsed.briefs.forEach((brief, i) => {
    const id = ids[i] as string;
    try {
      scheduler.enqueue({
        ownerKind: "production",
        ownerId: id,
        prompt: variantPrompt({ brief, language, ...(note ? { batchNote: note } : {}) }),
        ...(modelId ? { modelId } : {}),
      });
    } catch {
      // 新建的出片单位上不会有别的任务，入队只会因库出错失败：这一条记失败留在队列里让人看到，其余照常
      setVariantStatus(id, "failed");
    }
  });
  notify(`template:${templateId}`, "variants", { batchId });
  return presentBatch(batchId);
}

export interface VariantView {
  id: string;
  batchId: string | null;
  name: string | null;
  brief: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  /** 最新的 Agent 任务（用时、花费、模型、停止原因） */
  agent: AgentJobView | null;
  estimate: EstimateRecord | null;
  build: BuildView | null;
  /** 要人动手：素材待审、待确认花费（SCREEN-006 置顶） */
  needsMe: boolean;
}

export interface BatchView {
  id: string;
  templateId: string;
  note: string | null;
  targetLanguage: string | null;
  limitUsd: number;
  spentUsd: number;
  /** 有变体因为批次限额停在待确认花费（组头琥珀提示） */
  halted: boolean;
  createdAt: string;
  variants: VariantView[];
}

const NEEDS_ME = new Set(["asset_review", "awaiting_cost_confirm"]);

export function presentVariant(row: VariantRow): VariantView {
  const job = latestJobOf("production", row.id);
  return {
    id: row.id,
    batchId: row.batch_id,
    name: row.name,
    brief: row.brief,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agent: job ? present(job) : null,
    estimate: currentEstimate(row.id) ?? null,
    build: latestBuild(row.id) ?? null,
    needsMe: NEEDS_ME.has(row.status),
  };
}

function presentBatch(batchId: string): BatchView {
  const batch = db().prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as {
    id: string;
    template_id: string;
    note: string | null;
    target_language: string | null;
    created_at: string;
  };
  const rows = db()
    .prepare(
      `SELECT id, template_id, batch_id, brief, name, run_path, status, created_at, updated_at
         FROM productions WHERE batch_id = ? AND kind = 'variant' ORDER BY created_at, rowid`,
    )
    .all(batchId) as VariantRow[];
  const variants = rows.map(presentVariant);
  const budget = batchBudget(batchId);
  return {
    id: batch.id,
    templateId: batch.template_id,
    note: batch.note,
    targetLanguage: batch.target_language,
    limitUsd: budget.limitUsd,
    spentUsd: budget.spentUsd,
    halted: variants.some(
      (v) =>
        v.status === "awaiting_cost_confirm" &&
        (v.estimate?.reasons.includes("over_batch_limit") || v.estimate?.reasons.includes("batch_halted")) === true,
    ),
    createdAt: batch.created_at,
    variants,
  };
}

/** ④ 变体队列：这个模板的全部批次，新的在前 */
export function listVariants(templateId: string): { batches: BatchView[] } {
  requireTemplate(templateId);
  const batches = db()
    .prepare("SELECT id FROM batches WHERE template_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(templateId) as Array<{ id: string }>;
  return { batches: batches.map((b) => presentBatch(b.id)) };
}

export function requireVariant(id: string): VariantRow {
  const row = findVariant(id);
  if (!row) throw new VariantError("VARIANT_NOT_FOUND", "变体不存在", 404);
  return row;
}

/** 取消后不能再动的 */
const FINAL = ["done", "cancelled"];
const OPEN = [
  "queued",
  "agent_running",
  "awaiting_quota",
  "asset_review",
  "awaiting_cost_confirm",
  "building",
  "failed",
  "tripped",
  "interrupted",
];

/**
 * 取消一条变体（FLOW-003 分支）：Agent 在跑就停下会话、渲染中就让 hypit 取消那条 build，
 * 最后出片单位记「已取消」——出片单位上的已取消就是作废，不再估价、不再出片、不计入批次已花
 */
export async function cancelVariant(id: string): Promise<VariantView> {
  const row = requireVariant(id);
  if (FINAL.includes(row.status)) throw new VariantError("NOT_CANCELLABLE", "这条已经结束了，不能取消");
  // 先作废、再停：停任务时的状态同步看到已取消就不再动它（不会先闪一下「中断」），出片收尾也改不回来；
  // 只从没结束的状态改——这一刻刚好出完片的不改（8.1 第二轮审查 S2-L2 / S2-L4）
  if (!setVariantStatus(id, "cancelled", OPEN)) throw new VariantError("NOT_CANCELLABLE", "这条已经结束了，不能取消");
  for (const job of activeJobsOf("production", id)) await agentScheduler().cancel(job.id);
  if (row.status === "building") {
    try {
      await cancelBuild(id);
    } catch (error) {
      // 状态还是渲染中、执行器却刚好收尾了：没有可取消的，照样作废
      if (!(error instanceof BuildError && error.code === "NOT_RUNNING")) throw error;
    }
  }
  notify(`template:${row.template_id}`, "variants", { productionId: id });
  return presentVariant(requireVariant(id));
}
