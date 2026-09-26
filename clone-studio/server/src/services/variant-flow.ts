import { existsSync } from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { failFinishedJob, notify, onJobChange, workspaceOf } from "../agent/agent-service.js";
import { latestJobOf, requireJob, type AgentJobRow, type JobStatus } from "../agent/job-store.js";
import { variantRetryPrompt } from "../agent/prompts.js";
import { HypitError, runHypit } from "../hypit/cli.js";
import { requireTemplate } from "./archive.js";
import { readSources, VARIANT_REQUIRED, VARIANT_RUN, type SourceAsset } from "./variant-files.js";
import { findVariant, replaceAssets, setVariantStatus, userReplacedFiles, type VariantRow } from "./variant-store.js";

/**
 * 变体的状态接力（REQ-005、FLOW-003 步骤 2-3）：
 * - Agent 任务的状态同步到出片单位：排队 / Agent 写稿 / 等待额度 / 熔断 / 中断 / 失败 / 已取消；
 * - 任务说做完了，宿主自己核判据：variant.svrun 的 `hypit check` 通过、SOURCES.json 能解析且列的图都在、
 *   SCRIPT.md 存在。过了按 SOURCES.json 建素材卡、进「素材待审」；不过就把任务改判失败并写明原因（横条给继续 / 重跑）。
 * 只管还没进出片流水线的变体（run_path 为空）：素材通过之后出片单位归估价闸门与执行器管，Agent 任务不再动它。
 */

interface Log {
  error: (obj: object, msg: string) => void;
}

const silent: Log = { error: () => undefined };

/** 任务状态 → 出片单位状态（done 不在表里：要等核完判据） */
const JOB_TO_VARIANT: Partial<Record<JobStatus, string>> = {
  queued: "queued",
  running: "agent_running",
  awaiting_quota: "awaiting_quota",
  tripped: "tripped",
  interrupted: "interrupted",
  failed: "failed",
  // 任务被停成「已取消」（抽屉里中止一个还没开跑的任务、删除流程停任务）不等于人作废了这条变体：
  // 记中断，横条给重跑。变体的「已取消」只由 ④ 的取消设（8.1 审查 HIGH-1）
  cancelled: "interrupted",
};

/** 还归 Agent 这一段管的出片单位状态。已取消是终态；素材待审也在里面——打回会把它重新交给 Agent */
const AGENT_PHASE = ["queued", "agent_running", "awaiting_quota", "tripped", "interrupted", "failed", "asset_review"];

const VARIANT_FAIL_PREFIX = "变体未达完成判据";

/** 每一次「完成」只核一次（同复刻：按任务 + 结束时刻去重，继续后再完成要重新核） */
const verified = new Set<string>();

export function registerVariantFlow(log: Log = silent): () => void {
  const onChange = (job: AgentJobRow): void => {
    if (job.owner_kind !== "production") return;
    try {
      sync(job, log);
    } catch (error) {
      log.error({ jobId: job.id, error }, "同步变体状态时出错");
    }
  };
  const unsubscribe = onJobChange(onChange);
  // 重启：迁移把跑着的任务标了中断、把 agent_running 的出片单位标了中断，但排队中的出片单位还停在 queued；
  // 在核的那几秒退出的，任务是完成、出片单位却没进素材待审。按最新任务对齐一遍
  for (const row of openVariants()) {
    const job = latestJobOf("production", row.id);
    if (job) onChange(job);
  }
  return () => {
    unsubscribe();
    verified.clear();
  };
}

function openVariants(): VariantRow[] {
  const marks = AGENT_PHASE.map(() => "?").join(", ");
  return db()
    .prepare(
      `SELECT id, template_id, batch_id, brief, name, run_path, status, created_at, updated_at FROM productions
        WHERE kind = 'variant' AND run_path IS NULL AND status IN (${marks})`,
    )
    .all(...AGENT_PHASE) as VariantRow[];
}

function sync(job: AgentJobRow, log: Log): void {
  const variant = findVariant(job.owner_id);
  if (!variant || variant.run_path !== null || !AGENT_PHASE.includes(variant.status)) return;
  if (latestJobOf("production", variant.id)?.id !== job.id) return;
  if (job.status === "done") {
    // 已经核过、进了素材待审的这一次完成（重启后再对齐一遍时）不重核
    if (variant.status === "asset_review") return;
    const key = `${job.id}@${job.ended_at ?? ""}`;
    if (verified.has(key)) return;
    verified.add(key);
    verifyVariant(job).catch((error: unknown) => log.error({ jobId: job.id, error }, "核变体完成判据时出错"));
    return;
  }
  const next = JOB_TO_VARIANT[job.status];
  if (next && next !== variant.status && setVariantStatus(variant.id, next, AGENT_PHASE)) {
    notify(`template:${variant.template_id}`, "variants", { productionId: variant.id });
  }
}

export interface VariantJudgement {
  ok: boolean;
  reason: string | null;
  sources: SourceAsset[];
}

/** 核一条变体的完成判据。异常也收成「没过」给出原因，不让任务停在一个假的完成上 */
export async function verifyVariant(job: AgentJobRow): Promise<VariantJudgement> {
  let result: VariantJudgement;
  try {
    result = await judge(job);
  } catch (e) {
    result = { ok: false, reason: `核对完成判据时出错：${String(e)}`, sources: [] };
  }
  const variant = findVariant(job.owner_id);
  if (!variant) return result;
  // 核的过程中人取消了 / 已交给出片：结论不再作数，也不把任务改判失败（改判了抽屉就给「继续」，8.1 审查 HIGH-1）
  if (variant.run_path !== null || !AGENT_PHASE.includes(variant.status)) return result;
  if (!result.ok) {
    failFinishedJob(job.id, `${VARIANT_FAIL_PREFIX}：${result.reason ?? "未知原因"}`, job.ended_at);
    return result;
  }
  const accepted = db().transaction(() => {
    // 核的过程中人可能取消了、或打回 / 继续开了新一轮：只有仍是这一次完成的才进素材待审
    const now = requireJob(job.id);
    const current = findVariant(job.owner_id);
    if (!current || current.run_path !== null || !AGENT_PHASE.includes(current.status)) return false;
    if (
      latestJobOf("production", job.owner_id)?.id !== job.id ||
      now.status !== "done" ||
      now.ended_at !== job.ended_at
    ) {
      return false;
    }
    replaceAssets(job.owner_id, result.sources, userReplacedFiles(job.owner_id));
    return setVariantStatus(job.owner_id, "asset_review", AGENT_PHASE);
  })();
  if (accepted) notify(`template:${variant.template_id}`, "variants", { productionId: variant.id });
  return result;
}

async function judge(job: AgentJobRow): Promise<VariantJudgement> {
  const dir = workspaceOf(job);
  const missing = VARIANT_REQUIRED.filter((file) => !existsSync(path.join(dir, file)));
  if (missing.length > 0) return { ok: false, reason: `缺少 ${missing.join("、")}`, sources: [] };
  let sources: SourceAsset[];
  try {
    sources = readSources(dir);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), sources: [] };
  }
  const variant = findVariant(job.owner_id);
  const templateDir = variant ? requireTemplate(variant.template_id).workspace_path : null;
  if (!templateDir) throw new Error("模板没有工作目录");
  try {
    // 在变体目录里跑、显式 --workspace 指模板目录（REQ-002 MUST：所有 hypit 调用显式 --workspace）
    const out = await runHypit<{ ok?: unknown; diagnostics?: unknown }>(
      ["check", VARIANT_RUN, "--workspace", templateDir, "--json"],
      { cwd: dir, subject: { kind: "production", id: job.owner_id } },
    );
    if (out.json.ok !== true) return { ok: false, reason: "hypit check 未通过：check 输出 ok 不为 true", sources: [] };
  } catch (e) {
    const text = e instanceof HypitError ? [e.message, e.help, e.raw].filter(Boolean).join("\n") : String(e);
    return { ok: false, reason: `hypit check 未通过：${text.split("\n")[0] ?? ""}`, sources: [] };
  }
  return { ok: true, reason: null, sources };
}

/** 变体判据没过之后点「继续」：把原因交给会话（同复刻的 continuePromptFor）；不是这种情况返回 undefined */
export function variantContinuePrompt(job: AgentJobRow): string | undefined {
  if (job.owner_kind !== "production" || !job.session_id || job.status !== "failed") return undefined;
  const reason = job.stop_reason ?? "";
  if (!reason.startsWith(VARIANT_FAIL_PREFIX)) return undefined;
  return variantRetryPrompt(reason.slice(VARIANT_FAIL_PREFIX.length + 1));
}
