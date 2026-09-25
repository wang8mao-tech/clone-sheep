import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { agentScheduler, notify } from "../agent/agent-service.js";
import { activeJobsOf, latestJobOf } from "../agent/job-store.js";
import { variantReworkPrompt } from "../agent/prompts.js";
import { fitImage, ImageToolError, probeImage, type ImageSize } from "../lib/image-tool.js";
import { isReallyInside } from "../lib/safe-path.js";
import { requireTemplate } from "./archive.js";
import { logBackgroundError } from "./build-run.js";
import { batchBudget, EstimateError, estimateProduction, isEstimating } from "./estimate-run.js";
import {
  resetVariantProducts,
  SCRIPT_FILE,
  VARIANT_RUN,
  variantDir,
  variantRunPath,
  writeUserAssets,
} from "./variant-files.js";
import { listAssets, userReplacedFiles, type AssetRow, type VariantRow } from "./variant-store.js";
import { presentVariant, requireVariant, VariantError, type VariantView } from "./variants.js";

/**
 * 素材审核（REQ-005、FLOW-003 步骤 4-5 与分支）：看素材与台词、替换单张、素材通过交给估价闸门、
 * 打回（resume 该变体会话）、重跑（只清 Agent 的产物）。素材没通过不得出片：运行文件路径只在「素材通过」时写上，
 * 估价与出片执行器只认有运行文件路径的排队项。
 */

export const REWORK_NOTE_MAX = 2000;
/** 台词全文给界面看的上限：SCRIPT.md 正常几 KB，异常大的截断（喂模型的不走这里） */
const SCRIPT_VIEW_MAX = 200_000;

export interface AssetView {
  id: string;
  label: string | null;
  file: string | null;
  sourceUrl: string | null;
  /** 来源域名（卡片上显示的那一截） */
  sourceHost: string | null;
  replaced: boolean;
  gap: boolean;
  /** 图片地址；带文件修改时间，替换后浏览器不拿旧缓存 */
  imageUrl: string | null;
}

export interface VariantReviewState {
  /** 变体属于哪个模板：④ 的 `?variant=` 是别的模板的，前端按不存在处理（9.3） */
  templateId: string;
  variant: VariantView;
  assets: AssetView[];
  script: string | null;
  scriptTruncated: boolean;
  perItemLimitUsd: number;
  batch: { id: string; limitUsd: number; spentUsd: number } | null;
  /** 「素材通过」能不能点；不能时写明原因 */
  approveBlocked: string | null;
  reworkBlocked: string | null;
}

function dirOf(variant: VariantRow): string {
  const template = requireTemplate(variant.template_id);
  if (!template.workspace_path) throw new VariantError("NO_WORKSPACE", "这个模板没有工作目录");
  return variantDir(template.workspace_path, variant.id);
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function presentAsset(dir: string, row: AssetRow): AssetView {
  const file = row.file_path ? path.resolve(dir, row.file_path) : null;
  const stamp = file && existsSync(file) ? Math.round(statSync(file).mtimeMs) : null;
  return {
    id: row.id,
    label: row.label,
    file: row.file_path,
    sourceUrl: row.source_url,
    sourceHost: hostOf(row.source_url),
    replaced: row.replaced_by_user === 1,
    gap: row.is_gap === 1,
    imageUrl: stamp !== null ? `/api/assets/${row.id}/file?v=${stamp}` : null,
  };
}

export function reviewState(id: string): VariantReviewState {
  const variant = requireVariant(id);
  const dir = dirOf(variant);
  const assets = listAssets(id).map((row) => presentAsset(dir, row));
  const scriptPath = path.join(dir, SCRIPT_FILE);
  const raw = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : null;
  const limits = db().prepare("SELECT per_item_limit_usd FROM settings WHERE id = 1").get() as {
    per_item_limit_usd: number;
  };
  const gaps = assets.filter((a) => a.gap).length;
  const reviewing = variant.status === "asset_review";
  return {
    templateId: variant.template_id,
    variant: presentVariant(variant),
    assets,
    script: raw === null ? null : raw.slice(0, SCRIPT_VIEW_MAX),
    scriptTruncated: raw !== null && raw.length > SCRIPT_VIEW_MAX,
    perItemLimitUsd: limits.per_item_limit_usd,
    // 不含这条自己放行过的估价：估价卡会把这条的估价加上去画限额条，和闸门算的是同一个数（8.4 审查 S1-M2）
    batch: variant.batch_id ? { id: variant.batch_id, ...batchBudget(variant.batch_id, variant.id) } : null,
    approveBlocked: !reviewing ? "只有素材待审的变体能通过" : gaps > 0 ? `还有 ${gaps} 个缺口没补，先上传` : null,
    reworkBlocked: !reviewing ? "只有素材待审的变体能打回" : null,
  };
}

function assertReviewing(variant: VariantRow): void {
  if (variant.status !== "asset_review") {
    throw new VariantError("NOT_REVIEWING", "这条变体不在素材待审，不能改素材");
  }
}

interface AssetWithVariant {
  asset: AssetRow;
  variant: VariantRow;
  dir: string;
  target: string;
}

function locateAsset(assetId: string): AssetWithVariant {
  const asset = db().prepare("SELECT * FROM assets WHERE id = ?").get(assetId) as AssetRow | undefined;
  if (!asset?.file_path) throw new VariantError("ASSET_NOT_FOUND", "素材不存在", 404);
  const variant = requireVariant(asset.production_id);
  const dir = dirOf(variant);
  const target = path.resolve(dir, asset.file_path);
  if (!isReallyInside(dir, target)) throw new VariantError("ASSET_NOT_FOUND", "素材路径不在变体目录里", 404);
  return { asset, variant, dir, target };
}

/** 素材图片文件（数据根内、变体目录内）；缺口还没传的没有文件 */
export function assetFile(assetId: string): string {
  const { target } = locateAsset(assetId);
  if (!existsSync(target)) throw new VariantError("NO_FILE", "这张图还没有文件", 404);
  return target;
}

/**
 * 这张图该多大：读原文件（缺口也有同尺寸的占位图，判据要求它在）。
 * 原文件被人手动删了就不知道了，明确报错，不猜一个尺寸
 */
async function targetSize(located: AssetWithVariant): Promise<ImageSize> {
  if (!existsSync(located.target)) {
    throw new VariantError("UNKNOWN_SIZE", "原图不见了，不知道这张图该多大；重跑这条变体让 Agent 重新找图");
  }
  return probeImage(located.target, "原图（用它定尺寸）");
}

/**
 * 替换单张（REQ-005 MUST：保持文件名与尺寸，不重跑 Agent）。上传的图缩放裁切成原尺寸，写回原文件名，
 * 标「已替换」、清掉缺口。不起任何 Agent 任务，所以替换不会有新的 Agent 花费（AC-015）
 */
/** 上传之前先判能不能换：素材在、变体在素材待审。路由在收文件之前就调，不白收 20 MB（8.2 审查 L4） */
export function assertReplaceable(assetId: string): void {
  assertReviewing(locateAsset(assetId).variant);
}

/** REQ-005 输入表：替换图 jpg / png / webp——按实际编码判，不只看扩展名（8.2 审查 L2） */
const IMAGE_CODECS = new Set(["mjpeg", "png", "webp"]);

export async function replaceAsset(assetId: string, uploadPath: string): Promise<AssetView> {
  // 不管哪一步出错，上传的文件都删掉（8.2 审查 M3）
  let staging: string | undefined;
  let located: AssetWithVariant;
  try {
    located = locateAsset(assetId);
    assertReviewing(located.variant);
    const upload = await probeImage(uploadPath, "上传的图");
    if (!IMAGE_CODECS.has(upload.codec)) {
      throw new VariantError("BAD_FILE_TYPE", `只收 jpg / png / webp，上传的是 ${upload.codec || "未知格式"}`, 400);
    }
    const size = await targetSize(located);
    // 中间文件用服务端生成的名字：Agent 猜不到、没法预先占成硬链接，两次并发替换也不会撞（8.2 审查 L1）。
    // 写回用 rename：替换的是目录项，不会顺着原文件的硬链接写到别处
    staging = path.join(path.dirname(located.target), `.replacing-${randomUUID()}${path.extname(located.target)}`);
    await fitImage(uploadPath, staging, size);
    // 转换期间人可能点了通过 / 打回：状态变了就不写回
    assertReviewing(requireVariant(located.variant.id));
    renameSync(staging, located.target);
  } catch (error) {
    if (staging) rmSync(staging, { force: true });
    // Windows 上原图正被打开（界面正在读它、杀毒软件在扫）时 rename 会 EPERM：说清楚、让人稍后再试（8.2 第二轮审查 L1）
    if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EBUSY") {
      throw new VariantError("FILE_BUSY", "这张图正被别的程序打开，稍后再换一次", 409);
    }
    if (error instanceof ImageToolError) {
      // 工具不在是后端环境的问题，不是上传的图不对
      throw new VariantError(error.code, error.message, error.code === "TOOL_MISSING" ? 500 : 400);
    }
    throw error;
  } finally {
    rmSync(uploadPath, { force: true });
  }
  db().prepare("UPDATE assets SET replaced_by_user = 1, is_gap = 0, source_url = NULL WHERE id = ?").run(assetId);
  notify(`template:${located.variant.template_id}`, "variants", { productionId: located.variant.id });
  const row = db().prepare("SELECT * FROM assets WHERE id = ?").get(assetId) as AssetRow;
  return presentAsset(located.dir, row);
}

/**
 * 素材通过（FLOW-003 步骤 5）：有缺口不行。写上运行文件路径、回到排队，交给估价闸门：
 * 限额内自动出片（AC-017），超限停在待确认花费（AC-018），批次限额用尽之后的全部停（AC-019）
 */
export function approveAssets(id: string): VariantReviewState {
  const variant = requireVariant(id);
  assertReviewing(variant);
  const gaps = listAssets(id).filter((a) => a.is_gap === 1).length;
  if (gaps > 0) throw new VariantError("ASSETS_HAVE_GAPS", `还有 ${gaps} 个缺口没补，先上传`);
  if (!existsSync(path.join(dirOf(variant), VARIANT_RUN))) {
    throw new VariantError("NO_RUN", `变体目录里没有 ${VARIANT_RUN}`);
  }
  const moved = db()
    .prepare(
      "UPDATE productions SET run_path = ?, status = 'queued', updated_at = ? WHERE id = ? AND status = 'asset_review'",
    )
    .run(variantRunPath(id), new Date().toISOString(), id).changes;
  if (moved === 0) throw new VariantError("NOT_REVIEWING", "这条变体不在素材待审，不能通过");
  notify(`template:${variant.template_id}`, "variants", { productionId: id });
  // plan / pricing 不花钱，后台跑；估价结论与闸门放行由估价模块推 estimate 事件。
  // 正在估 / 已经不能估（被取消了）是正常的；其余没跑起来的记日志，不悄悄吞掉（8.2 审查 M4）
  estimateProduction(id).catch((error: unknown) => {
    if (error instanceof EstimateError && (error.code === "ESTIMATE_IN_FLIGHT" || error.code === "NOT_ESTIMABLE"))
      return;
    logBackgroundError({ productionId: id, error }, "素材通过后的估价没跑起来");
  });
  return reviewState(id);
}

/** 打回（FLOW-003 分支）：意见 resume 该变体的会话，去首尾空白 1-2000 字 */
export function reworkVariant(id: string, rawNote: string): VariantReviewState {
  const note = rawNote.trim();
  if (note.length === 0 || [...note].length > REWORK_NOTE_MAX) {
    throw new VariantError("INVALID_NOTE", `打回意见要写 1-${REWORK_NOTE_MAX} 字`, 400);
  }
  const variant = requireVariant(id);
  assertReviewing(variant);
  const job = latestJobOf("production", id);
  if (!job) throw new VariantError("NO_JOB", "这条变体没有 Agent 任务，接不上意见");
  // 打回意见里说「USER_ASSETS.json 列的图不要动」：先把人替换过的图写进去（8.2 审查 M5）
  writeUserAssets(dirOf(variant), userReplacedFiles(id));
  agentScheduler().rework(job.id, variantReworkPrompt(note));
  return reviewState(id);
}

/** 能重跑的变体：Agent 这一段停下了，或出片失败了（重跑 = 重新写稿、重新找图） */
export const RERUNNABLE = ["failed", "tripped", "interrupted", "asset_review"];

/**
 * 重跑（FLOW-003 分支）：清掉 Agent 的稿子、清单与抓来的图，留下模板原稿与用户替换过的图（Task 5.2 复审 S1-M4），
 * 按原任务提示与模型开一个新会话。出片失败后重跑同样走这里：运行文件路径清掉，素材要重新审
 */
export function rerunVariant(id: string): VariantView {
  const variant = requireVariant(id);
  if (!RERUNNABLE.includes(variant.status)) {
    throw new VariantError("NOT_RERUNNABLE", "只有失败、熔断、中断或素材待审的变体可以重跑");
  }
  if (activeJobsOf("production", id).length > 0) throw new VariantError("JOB_ACTIVE", "这条变体的任务还没结束");
  // 正在重新估价：估完的结论会改它的状态，等它估完（8.2 审查 M1）
  if (isEstimating(id)) throw new VariantError("ESTIMATING", "这条正在估价，等估完再重跑");
  const job = latestJobOf("production", id);
  if (!job?.prompt) throw new VariantError("NO_PROMPT", "这条变体没有保存任务提示，无法重跑");
  const template = requireTemplate(variant.template_id);
  resetVariantProducts(dirOf(variant), userReplacedFiles(id), template.workspace_path ?? undefined);
  db().transaction(() => {
    db().prepare("DELETE FROM assets WHERE production_id = ? AND replaced_by_user = 0").run(id);
    db()
      .prepare("UPDATE productions SET run_path = NULL, status = 'queued', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  })();
  agentScheduler().enqueue({
    ownerKind: "production",
    ownerId: id,
    prompt: job.prompt,
    ...(job.model_id ? { modelId: job.model_id } : {}),
  });
  notify(`template:${variant.template_id}`, "variants", { productionId: id });
  return presentVariant(requireVariant(id));
}
