import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { notify } from "../agent/agent-service.js";
import { findTemplate, requireTemplate } from "./archive.js";
import { activityFor, ensureActivityWatcher, stopActivityWatcher } from "./build-activity.js";
import { cancelHypitBuild, execute, type RunningBuild } from "./build-execute.js";
import {
  BuildError,
  hasBuild,
  latestBuildRow,
  presentBuild,
  readBuildRow,
  readProduction,
  setProductionStatus,
  type BuildRow,
  type BuildView,
} from "./build-store.js";
import { currentEstimate } from "./estimate-store.js";
import { estimateProduction } from "./estimate-run.js";

/**
 * 出片执行器的队列一侧（REQ-006 出片、REQ-009 台账）：排队中、闸门放行（auto 或人已确认）的出片单位，
 * 按 `settings.render_concurrency`（默认 1）推进；每一条的执行过程在 build-execute.ts。
 * 取消 = 中止本地子进程 + 让 hypit 取消那条 build；重试 = 回排队再推。
 */

export { BuildError, type BuildView } from "./build-store.js";

/** 运行中的 build：进度与取消句柄只在内存里 */
const running = new Map<string, RunningBuild>();

export interface BuildLog {
  error: (obj: object, msg: string) => void;
  info?: (obj: object, msg: string) => void;
}

const silent: BuildLog = { error: () => undefined };
let log: BuildLog = silent;

export function setBuildLog(next: BuildLog): void {
  log = next;
}

function renderConcurrency(): number {
  const row = db().prepare("SELECT render_concurrency FROM settings WHERE id = 1").get() as
    { render_concurrency: number } | undefined;
  return Math.max(1, row?.render_concurrency ?? 1);
}

/**
 * 闸门放行了没有：最新一次估价是 auto，或 confirm 且人已确认；而且这次估价要晚于这条的上一次 build——
 * 一次放行只管一次出片，「重试出片」必须重新估价过闸门（Task 7.2），旧结论不能被顺手拿去再起一次
 */
function released(productionId: string): boolean {
  const est = currentEstimate(productionId);
  if (!est) return false;
  const last = latestBuildRow(productionId);
  // 相等也不行：估价落库与它放行的那次 build 常在同一毫秒（7.2 审查 S2-H1），相等说明就是那一次的放行
  if (last && est.createdAt <= last.created_at) return false;
  return est.decision === "auto" || (est.decision === "confirm" && est.confirmedAt !== null);
}

/** 闸门放行了的（auto，或 confirm 且人已确认）、还排着队的出片单位，按建立先后 */
export function releasedQueued(): string[] {
  const rows = db()
    .prepare("SELECT id FROM productions WHERE status = 'queued' ORDER BY created_at, rowid")
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id).filter((id) => !running.has(id) && released(id));
}

/**
 * 把放行了的出片单位按并发上限推进去。估价结论出来、人确认、一条出完、重启，都调它。
 * 返回这次真的启动了几条（起不来的记日志、不计数，也不会一直占着名额）
 */
export function pumpBuilds(): number {
  let started = 0;
  for (const id of releasedQueued()) {
    if (running.size >= renderConcurrency()) break;
    try {
      beginBuild(id);
      started += 1;
    } catch (error) {
      log.error({ productionId: id, error }, "出片没起来");
    }
  }
  return started;
}

/** 起一条出片。同一条同时只跑一个；不满足放行条件的直接拒 */
export async function startBuild(productionId: string): Promise<BuildView> {
  return beginBuild(productionId);
}

/** 校验、落台账、把执行过程放到后台；同步返回，错误同步抛（pump 据此计数） */
function beginBuild(productionId: string): BuildView {
  if (running.has(productionId)) throw new BuildError("这条正在出片", "BUILD_IN_FLIGHT", 409);
  const production = readProduction(productionId);
  if (!production) throw new BuildError("出片单位不存在", "PRODUCTION_NOT_FOUND", 404);
  if (production.status !== "queued")
    throw new BuildError(`这条现在是「${production.status}」，不能出片`, "NOT_QUEUED", 409);
  if (!production.run_path) throw new BuildError("出片单位没有 run 文件", "NO_RUN", 409);
  const estimate = currentEstimate(productionId);
  if (!estimate || !released(productionId)) throw new BuildError("这条还没过花钱闸门", "NOT_RELEASED", 409);
  const template = requireTemplate(production.template_id);
  const dir = template.workspace_path;
  if (!dir) throw new BuildError("模板没有工作目录", "NO_WORKSPACE", 409);

  const buildId = randomUUID();
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO builds (id, production_id, estimate_usd, status, started_at, created_at)
       VALUES (?, ?, ?, 'running', ?, ?)`,
    )
    .run(buildId, productionId, estimate.totalUsd, now, now);
  setProductionStatus(productionId, "building", now);
  const entry: RunningBuild = { buildId, dir, controller: new AbortController(), progress: null };
  running.set(productionId, entry);
  // Runtime 侧的结构化进度：这个工作目录有 build 在跑就开着一个 watcher
  try {
    ensureActivityWatcher(dir);
  } catch (error) {
    log.error({ productionId, error }, "activity watcher 没起来，进度只靠 status 的进度行");
  }
  announce(production.template_id, productionId);

  void execute(production, entry, {
    onProgress: () => announce(production.template_id, productionId),
    log: (obj, msg) => log.error(obj, msg),
    knownHypitBuildIds: () =>
      [...running.values()]
        .filter((r) => r.dir === dir && r.buildId !== buildId)
        .map((r) => readBuildRow(r.buildId)?.hypit_build_id)
        .filter((id): id is string => typeof id === "string"),
  }).finally(() => {
    running.delete(productionId);
    if (![...running.values()].some((r) => r.dir === dir)) stopActivityWatcher(dir);
    announce(production.template_id, productionId);
    // 这条出完了，队列里下一条接上
    pumpBuilds();
  });
  return requireBuild(buildId);
}

function announce(templateId: string, productionId: string): void {
  notify(`template:${templateId}`, "build", { productionId });
}

/**
 * 人点「取消」：中止本地子进程（连子孙）并让 hypit 取消这条 build。
 * 台账里还没有 hypit 的 id（提交还没返回）时由执行过程在提交返回后自己取消
 */
export async function cancelBuild(productionId: string): Promise<BuildView> {
  const entry = running.get(productionId);
  if (!entry) throw new BuildError("这条没有在出片", "NOT_RUNNING", 409);
  entry.controller.abort();
  const hypitBuildId = readBuildRow(entry.buildId)?.hypit_build_id ?? null;
  if (hypitBuildId) await cancelHypitBuild(entry.dir, hypitBuildId, { kind: "production", id: productionId });
  return requireBuild(entry.buildId);
}

/** 删除模板 / 出片单位前：中止它们正在跑的出片并让 hypit 取消；等的是 `hypit cancel` 返回，不等本地执行过程收尾（它随中止马上结束） */
export async function cancelRunningBuilds(productionIds: readonly string[]): Promise<void> {
  await Promise.all(
    productionIds
      .filter((id) => running.has(id))
      .map((id) => cancelBuild(id).catch((error: unknown) => log.error({ productionId: id, error }, "取消出片失败"))),
  );
}

/**
 * 重启时：上次进程死掉时还在跑的 build，Worker 上可能还在渲染（hypit：不看了 Build 照跑）。
 * 逐条让 hypit 取消，不然「重试出片」会在它旁边再起一条，workers=1 与渲染并发上限都成了空话
 */
export async function cancelOrphanedBuilds(
  orphans: ReadonlyArray<{ productionId: string; hypitBuildId: string }>,
): Promise<number> {
  let cancelled = 0;
  for (const { productionId, hypitBuildId } of orphans) {
    const production = readProduction(productionId);
    const dir = production ? findTemplate(production.template_id)?.workspace_path : null;
    if (!dir) continue;
    if (await cancelHypitBuild(dir, hypitBuildId, { kind: "production", id: productionId })) cancelled += 1;
    else log.error({ productionId, hypitBuildId }, "重启后没能取消上次留下的 build");
  }
  return cancelled;
}

/** 「重试出片」：出过片但失败 / 中断的回到排队，重新估价过闸门（旧的放行不再作数，Task 7.2） */
export function retryBuild(productionId: string): { queued: boolean } {
  const production = readProduction(productionId);
  if (!production) throw new BuildError("出片单位不存在", "PRODUCTION_NOT_FOUND", 404);
  if (!["failed", "interrupted"].includes(production.status)) {
    throw new BuildError(`这条现在是「${production.status}」，不用重试`, "NOT_RETRYABLE", 409);
  }
  if (!hasBuild(productionId)) {
    throw new BuildError("这条还没出过片：是估价没过，用「重新估价」", "NOT_RETRYABLE", 409);
  }
  // 回到排队、重新估价过闸门：限额内由估价结果自动起片，超限停在「待确认花费」等人确认（Task 7.2）
  setProductionStatus(productionId, "queued");
  estimateProduction(productionId).catch((error: unknown) =>
    log.error({ productionId, error }, "重试出片的重新估价没跑起来"),
  );
  return { queued: true };
}

export function latestBuild(productionId: string): BuildView | undefined {
  const row = latestBuildRow(productionId);
  return row ? present(row) : undefined;
}

function requireBuild(id: string): BuildView {
  const row = readBuildRow(id);
  if (!row) throw new BuildError("build 记录不存在", "BUILD_NOT_FOUND", 404);
  return present(row);
}

function present(row: BuildRow): BuildView {
  const live = running.get(row.production_id);
  if (!live || live.buildId !== row.id) return presentBuild(row, null);
  const a = activityFor(live.dir, row.hypit_build_id);
  return presentBuild(row, {
    progress: live.progress,
    activity: a ? { phases: a.phases, requests: a.work.requests ?? null } : null,
  });
}
