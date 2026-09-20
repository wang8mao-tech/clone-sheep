import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { workspaceDir } from "../hypit/workspace.js";
import { procs } from "../lib/procs.js";
import { ArchiveError, requireClient, requireTemplate } from "./archive.js";

/**
 * 级联删除（REQ-001，AC-001 / AC-002）。
 *
 * Spec 6.3 定死的顺序：先停任务、再删目录、最后删库；任一步失败则整体报错并保留记录。
 * 「删目录在删库之前」意味着删库失败时目录已经没了，所以这里先把目录移进
 * <data>/.trash/，库删成功才真正落盘删除，库删失败就把目录移回原处。
 */

const ACTIVE_JOB_STATUS = ["queued", "running", "awaiting_quota"] as const;
const ACTIVE_BUILD_STATUS = ["queued", "running"] as const;
const ACTIVE_PRODUCTION_STATUS = [
  "queued",
  "agent_running",
  "awaiting_quota",
  "asset_review",
  "awaiting_cost_confirm",
  "building",
] as const;

export interface DeletionImpact {
  kind: "client" | "template";
  id: string;
  name: string;
  /** 客户删除时连带的模板数；模板删除时恒为 0 */
  templates: number;
  /** 连带的成片与变体条目数 */
  productions: number;
  /** 将被中止的运行中任务数（Agent 会话 + 出片），弹窗要按它写「将中止 N 个任务」 */
  runningTasks: number;
  /** 将从磁盘删掉的目录 */
  directories: string[];
}

export function clientImpact(clientId: string): DeletionImpact {
  const client = requireClient(clientId);
  const templateIds = templateIdsOfClient(clientId);
  return {
    kind: "client",
    id: client.id,
    name: client.name,
    templates: templateIds.length,
    productions: countProductions(templateIds),
    runningTasks: countRunningTasks(templateIds),
    directories: [clientDir(clientId)],
  };
}

export function templateImpact(templateId: string): DeletionImpact {
  const template = requireTemplate(templateId);
  return {
    kind: "template",
    id: template.id,
    name: template.name,
    templates: 0,
    productions: countProductions([templateId]),
    runningTasks: countRunningTasks([templateId]),
    directories: [template.workspace_path ?? workspaceDir(template.client_id, template.id)],
  };
}

export function deleteClient(clientId: string): DeletionImpact {
  const impact = clientImpact(clientId);
  const templateIds = templateIdsOfClient(clientId);
  const productionIds = productionIdsOf(templateIds);
  stopTasks(templateIds);
  removeWithRollback(impact.directories, () => {
    purgeOwnedRecords(templateIds, productionIds);
    db().prepare("DELETE FROM clients WHERE id = ?").run(clientId);
  });
  return impact;
}

export function deleteTemplate(templateId: string): DeletionImpact {
  const impact = templateImpact(templateId);
  const productionIds = productionIdsOf([templateId]);
  stopTasks([templateId]);
  removeWithRollback(impact.directories, () => {
    purgeOwnedRecords([templateId], productionIds);
    db().prepare("DELETE FROM templates WHERE id = ?").run(templateId);
  });
  return impact;
}

/**
 * agent_jobs 与 hypit_calls 的 owner 是多态的（template 或 production），
 * 没有外键，SQLite 的 ON DELETE CASCADE 管不到，必须显式删。
 * 不删就会留下指向已不存在对象的孤儿记录，AC-001 的「数据库无其记录」不成立。
 * agent_messages 有到 agent_jobs 的外键，随之级联。
 */
function purgeOwnedRecords(templateIds: readonly string[], productionIds: readonly string[]): void {
  if (templateIds.length === 0) return;
  const d = db();
  const ownerWhere =
    `(owner_kind = 'template' AND owner_id IN (${marks(templateIds.length)}))` +
    ` OR (owner_kind = 'production' AND owner_id IN (${marks(productionIds.length)}))`;
  d.prepare(`DELETE FROM agent_jobs WHERE ${ownerWhere}`).run(...templateIds, ...productionIds);

  const subjectWhere =
    `(subject_kind = 'template' AND subject_id IN (${marks(templateIds.length)}))` +
    ` OR (subject_kind = 'production' AND subject_id IN (${marks(productionIds.length)}))`;
  d.prepare(`DELETE FROM hypit_calls WHERE ${subjectWhere}`).run(...templateIds, ...productionIds);
}

function clientDir(clientId: string): string {
  return path.join(config.dataRoot, "clients", clientId);
}

function templateIdsOfClient(clientId: string): string[] {
  return (db().prepare("SELECT id FROM templates WHERE client_id = ?").all(clientId) as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

function productionIdsOf(templateIds: readonly string[]): string[] {
  if (templateIds.length === 0) return [];
  const marks = templateIds.map(() => "?").join(", ");
  return (
    db().prepare(`SELECT id FROM productions WHERE template_id IN (${marks})`).all(...templateIds) as Array<{
      id: string;
    }>
  ).map((r) => r.id);
}

function countProductions(templateIds: readonly string[]): number {
  return productionIdsOf(templateIds).length;
}

function countRunningTasks(templateIds: readonly string[]): number {
  if (templateIds.length === 0) return 0;
  const productionIds = productionIdsOf(templateIds);
  const d = db();

  const jobs = (
    d
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_jobs
          WHERE status IN (${marks(ACTIVE_JOB_STATUS.length)})
            AND ((owner_kind = 'template' AND owner_id IN (${marks(templateIds.length)}))
              OR (owner_kind = 'production' AND owner_id IN (${marks(productionIds.length)})))`,
      )
      .get(...ACTIVE_JOB_STATUS, ...templateIds, ...productionIds) as { n: number }
  ).n;

  if (productionIds.length === 0) return jobs;

  const builds = (
    d
      .prepare(
        `SELECT COUNT(*) AS n FROM builds
          WHERE status IN (${marks(ACTIVE_BUILD_STATUS.length)})
            AND production_id IN (${marks(productionIds.length)})`,
      )
      .get(...ACTIVE_BUILD_STATUS, ...productionIds) as { n: number }
  ).n;

  return jobs + builds;
}

/**
 * 中止关联任务：先杀子进程，再把库里的活跃记录标为已取消。
 * 顺序不能反——先标库后杀进程的话，进程的收尾回调可能把状态又写回去。
 */
function stopTasks(templateIds: readonly string[]): void {
  if (templateIds.length === 0) return;
  const productionIds = productionIdsOf(templateIds);
  const templateSet = new Set(templateIds);
  const productionSet = new Set(productionIds);

  procs.killBySubject((subject) =>
    subject.kind === "template"
      ? templateSet.has(subject.id)
      : subject.kind === "production" && productionSet.has(subject.id),
  );

  const d = db();
  const now = new Date().toISOString();
  d.transaction(() => {
    d.prepare(
      `UPDATE agent_jobs SET status = 'cancelled', ended_at = COALESCE(ended_at, ?),
              stop_reason = COALESCE(stop_reason, 'deleted')
        WHERE status IN (${marks(ACTIVE_JOB_STATUS.length)})
          AND ((owner_kind = 'template' AND owner_id IN (${marks(templateIds.length)}))
            OR (owner_kind = 'production' AND owner_id IN (${marks(productionIds.length)})))`,
    ).run(now, ...ACTIVE_JOB_STATUS, ...templateIds, ...productionIds);

    if (productionIds.length > 0) {
      d.prepare(
        `UPDATE builds SET status = 'cancelled', ended_at = COALESCE(ended_at, ?)
          WHERE status IN (${marks(ACTIVE_BUILD_STATUS.length)})
            AND production_id IN (${marks(productionIds.length)})`,
      ).run(now, ...ACTIVE_BUILD_STATUS, ...productionIds);

      d.prepare(
        `UPDATE productions SET status = 'cancelled', updated_at = ?
          WHERE status IN (${marks(ACTIVE_PRODUCTION_STATUS.length)})
            AND id IN (${marks(productionIds.length)})`,
      ).run(now, ...ACTIVE_PRODUCTION_STATUS, ...productionIds);
    }
  })();
}

/**
 * 把目录挪进回收区 → 跑删库 → 成功就落盘删掉，失败就挪回原处。
 * 中间任何一步抛出，调用方拿到的都是「什么都没变」的状态。
 */
export function removeWithRollback(directories: readonly string[], deleteRows: () => void): void {
  const trashRoot = path.join(config.dataRoot, ".trash");
  const moved: Array<{ from: string; to: string }> = [];

  try {
    for (const dir of directories) {
      if (!existsSync(dir)) continue;
      mkdirSync(trashRoot, { recursive: true });
      const to = path.join(trashRoot, `${path.basename(dir)}-${Date.now()}`);
      renameSync(dir, to);
      moved.push({ from: dir, to });
    }
  } catch (error) {
    restore(moved);
    throw new ArchiveError(
      `删除失败：工作目录移不动（${(error as Error).message}）。文件可能被别的程序占用。`,
      "DIRECTORY_BUSY",
      409,
    );
  }

  try {
    db().transaction(deleteRows)();
  } catch (error) {
    restore(moved);
    throw new ArchiveError(`删除失败：数据库未能删除记录（${(error as Error).message}）`, "DB_DELETE_FAILED", 500);
  }

  // 库已经删干净，目录留着只是垃圾。删不掉也不该把失败报给用户——
  // 对象已经没了，报错只会让人以为还在。
  for (const { to } of moved) {
    try {
      rmSync(to, { recursive: true, force: true });
    } catch {
      // 下次启动或手工清理 .trash 即可
    }
  }
}

function restore(moved: ReadonlyArray<{ from: string; to: string }>): void {
  for (const { from, to } of moved) {
    try {
      if (existsSync(to)) renameSync(to, from);
    } catch {
      // 挪不回去时目录还在 .trash 里，不会丢，但要让上层照常报错
    }
  }
}

function marks(count: number): string {
  return count === 0 ? "NULL" : Array.from({ length: count }, () => "?").join(", ");
}
