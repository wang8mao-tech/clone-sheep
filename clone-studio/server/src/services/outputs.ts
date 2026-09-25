import { notify } from "../agent/agent-service.js";
import { latestJobOf } from "../agent/job-store.js";
import { db } from "../db/index.js";
import { ArchiveError, normalizeName, requireTemplate } from "./archive.js";
import type { BuildView } from "./build-store.js";
import { latestBuild, logBackgroundError } from "./build-run.js";
import { currentEstimate } from "./estimate-store.js";
import { productionCosts } from "./output-costs.js";
import { cachedOutputMeta, ensureOutputMeta } from "./output-meta.js";
import { downloadableFile } from "./output-zip.js";
import {
  isListed,
  LISTED,
  OUTPUT_COLUMNS,
  outputName,
  requireOutput,
  type ProductionOutputRow,
} from "./output-store.js";

/** ⑤ 成片库（REQ-007、SCREEN-008）：网格里的出片单位、改名。收哪些见 LISTED */

export interface OutputStop {
  step: "estimate" | "build" | "agent";
  text: string;
  /** Agent 那一段停下时任务的原始停因（`budget：花费达到上限`、`user_abort` …）：界面用 ④ 同一个 describeStop 翻成人话 */
  reason?: string | null;
}

export type OutputStatus = "done" | "building" | "pending" | "failed" | "cancelled" | "interrupted";

export interface OutputView {
  id: string;
  kind: "replica" | "variant";
  name: string;
  version: number;
  /** 卡片上的状态：完成 / 渲染中 / 在流水线里（排队、写稿、待审、待确认）/ 失败（含熔断）/ 已取消 / 中断 */
  status: OutputStatus;
  /** 出片单位的原始状态：卡片要说清在流水线的哪一步（9.2 审查 S1-4） */
  productionStatus: string;
  /** 复刻片旧版：已被第几版取代（只有通过验货的那一版算成片） */
  supersededBy: number | null;
  /** 通过验货的那一版复刻片 */
  approved: boolean;
  durationS: number | null;
  coverUrl: string | null;
  /** 这条自己的花费：同花费明细的合计（变体 = Agent 任务 + 出片；复刻片不含共用的复刻会话） */
  costUsd: number;
  costIsEstimate: boolean;
  /** 完成且文件还在：能播放、下载、打包 */
  downloadable: boolean;
  /**
   * 能「重试出片」：与 build/retry 同一套判断（失败 / 中断、出过片、最近一次出片失败或被取消、还有运行文件）。
   * 变体在 ④ 重跑后运行文件清掉了，Agent 再失败时旧的出片失败还在台账里，前端分不出来，由这里说（9.2 第三轮审查 S1-1）
   */
  retryable: boolean;
  /**
   * 停下的变体 / 复刻片停在哪一步、原文是什么：先说哪一步失败，再给原文（Design-Brief §6.2）。
   * 顺序同 ④ 的 stopReason：估价比最近一次出片新而没过 → 估价；能重试出片 → 出片；变体 Agent 那一段停下 → Agent。
   * 由服务端给，前端不再从卡片状态猜（9.2 第四轮审查 S1-H1 / S1-M1）
   */
  stop: OutputStop | null;
  build: BuildView | null;
  createdAt: string;
  updatedAt: string;
}

/** 网格收的出片单位（新的在前） */
function listedRows(templateId: string): ProductionOutputRow[] {
  return db()
    .prepare(
      `SELECT ${OUTPUT_COLUMNS} FROM productions p
        WHERE p.template_id = ? AND p.output_deleted_at IS NULL AND ${LISTED}
        ORDER BY p.created_at DESC, p.rowid DESC`,
    )
    .all(templateId) as ProductionOutputRow[];
}

/**
 * 「已被 vN 取代」的 N：出片完成的最高版本（③ 只能通过最新一版，通过的那版就是它）。
 * 从全部复刻片里算、删过成片的也算：删了通过的那版，旧版照样是被它取代的（9.1 审查 S2-7）
 */
function replicaHead(templateId: string): number | null {
  const newest = db()
    .prepare("SELECT MAX(version) AS v FROM productions WHERE template_id = ? AND kind = 'replica' AND status = 'done'")
    .get(templateId) as { v: number | null };
  return newest.v;
}

const STOPPED = new Set(["failed", "interrupted", "tripped"]);

function stopOf(row: ProductionOutputRow, build: BuildView | null, retryable: boolean): OutputStop | null {
  if (!STOPPED.has(row.status)) return null;
  const estimate = currentEstimate(row.id);
  if (estimate?.decision === "blocked" && (!build || estimate.createdAt > build.createdAt)) {
    return {
      step: "estimate",
      text: ["估价没过，不出片", estimate.reason ?? estimate.error].filter(Boolean).join("\n"),
    };
  }
  if (retryable && build) {
    const head = `出片失败${build.errorCode ? ` · ${build.errorCode}` : ""}`;
    return { step: "build", text: [head, build.errorMessage].filter(Boolean).join("\n") };
  }
  if (row.kind === "variant") {
    const job = latestJobOf("production", row.id);
    return { step: "agent", text: "Agent 写稿停下", reason: job?.stop_reason ?? null };
  }
  return null;
}

function cardStatus(row: ProductionOutputRow): OutputStatus {
  switch (row.status) {
    case "done":
    case "building":
    case "failed":
    case "cancelled":
    case "interrupted":
      return row.status;
    // 熔断算失败（REQ-007 把它和失败、中断归在能重来的一类），不留在「进行中」里
    case "tripped":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * 网格先给缓存里的时长与封面（没有就是占位）；没取过的在后台取（同时最多 2 个），取完推一次 outputs 事件让页面重拉。
 * 列表不等 ffmpeg（9.1 审查 S2-4）
 */
function fillMetaLater(templateId: string, buildIds: readonly string[]): void {
  if (buildIds.length === 0) return;
  void Promise.allSettled(buildIds.map((id) => ensureOutputMeta(id))).then((results) => {
    // 暂时性失败已经在 ensureOutputMeta 里消化成 null；这里剩下的是库出错之类，记下来别吞掉（9.1 第二轮审查 S2-L3）
    for (const r of results) {
      if (r.status === "rejected")
        logBackgroundError({ templateId, error: r.reason as unknown }, "成片封面 / 时长没取成");
    }
    if (results.some((r) => r.status === "fulfilled" && r.value !== null)) {
      notify(`template:${templateId}`, "outputs", { meta: true });
    }
  });
}

export function listOutputs(templateId: string): OutputView[] {
  const template = requireTemplate(templateId);
  const head = replicaHead(templateId);
  const missing: string[] = [];
  const views = listedRows(templateId).map((row): OutputView => {
    const build = latestBuild(row.id) ?? null;
    // 文件被人挪走了、或台账路径不在数据根里：不给下载 / 打包，也不去抽帧（与下载、打包同一个判断）
    const done =
      row.status === "done" &&
      build?.status === "done" &&
      build.outputPath !== null &&
      downloadableFile(build.outputPath) !== null;
    const meta = done && build ? cachedOutputMeta(build.id) : null;
    if (done && build && !meta) missing.push(build.id);
    const cost = productionCosts(row);
    const approved = row.id === template.approved_replica_id;
    const retryable =
      (row.status === "failed" || row.status === "interrupted") &&
      row.run_path !== null &&
      build !== null &&
      (build.status === "failed" || build.status === "cancelled");
    return {
      id: row.id,
      kind: row.kind,
      name: outputName(row),
      version: row.version,
      status: cardStatus(row),
      productionStatus: row.status,
      supersededBy: row.kind === "replica" && !approved && head !== null && head > row.version ? head : null,
      approved,
      durationS: meta?.durationS ?? null,
      coverUrl: meta?.coverPath ? `/api/productions/${row.id}/cover?v=${encodeURIComponent(build?.id ?? "")}` : null,
      costUsd: cost.totalUsd,
      costIsEstimate: cost.totalIsEstimate,
      downloadable: done,
      retryable,
      stop: stopOf(row, build, retryable),
      build,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
  fillMetaLater(templateId, missing);
  return views;
}

/** 改名：去首尾空白后 1-60 字（REQ-007） */
export function renameOutput(id: string, rawName: string): ProductionOutputRow {
  requireOutput(id);
  if (!isListed(id)) throw new ArchiveError("这条不在成片库里", "OUTPUT_NOT_FOUND", 404);
  const name = normalizeName(rawName, 60, "成片名称");
  db().prepare("UPDATE productions SET name = ?, updated_at = ? WHERE id = ?").run(name, new Date().toISOString(), id);
  return requireOutput(id);
}
