import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
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
 *
 * 「整体报错并保留记录」只对目录和库记录成立，对进程不成立：进程杀了就回不来。
 * 所以杀进程必须排在最前且要等它真的退出（AC-002），失败后由
 * markStoppedAsInterrupted 把库里的状态改写成与现实一致的「中断」。
 */

/** rename 撞 EPERM/EBUSY 时的重试次数与间隔（Windows 句柄释放有延迟） */
const RENAME_RETRIES = 5;
const RENAME_RETRY_DELAY_MS = 120;

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

export async function deleteClient(clientId: string): Promise<DeletionImpact> {
  const impact = clientImpact(clientId);
  const templateIds = templateIdsOfClient(clientId);
  const productionIds = productionIdsOf(templateIds);
  return runDeletion(impact, templateIds, productionIds, () => {
    db().prepare("DELETE FROM clients WHERE id = ?").run(clientId);
  });
}

export async function deleteTemplate(templateId: string): Promise<DeletionImpact> {
  const impact = templateImpact(templateId);
  const productionIds = productionIdsOf([templateId]);
  return runDeletion(impact, [templateId], productionIds, () => {
    db().prepare("DELETE FROM templates WHERE id = ?").run(templateId);
  });
}

/**
 * 删除的公共编排：杀进程 → 移目录 → 一个事务里删库 → 落盘删除。
 *
 * 杀进程是唯一回不去的一步，所以它之后的任何失败都要把库里那些还标着「在跑」的
 * 记录写成中断——对象按 REQ-001 保留下来了，但它上面的任务是真的死了，
 * 界面不能继续转一个已经没有进程在跑的圈。
 */
async function runDeletion(
  impact: DeletionImpact,
  templateIds: readonly string[],
  productionIds: readonly string[],
  deleteOwner: () => void,
): Promise<DeletionImpact> {
  await stopProcesses(templateIds, productionIds);
  try {
    removeWithRollback(impact.directories, () => {
      purgeOwnedRecords(templateIds, productionIds);
      deleteOwner();
    });
  } catch (error) {
    markStoppedAsInterrupted(templateIds, productionIds);
    throw error;
  }
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
 * 杀掉这些对象名下还在跑的子进程，等它们真的退出。
 *
 * 这里只动进程、不写库。成功路径上这些行马上就要被 DELETE，标它们是白写；
 * 而一旦写了又提交了，删除失败时就回滚不掉——那正是「对象保留下来，
 * 上面的任务却被静默标死」的来源。库侧状态统一由调用方按成败分别处理。
 */
async function stopProcesses(templateIds: readonly string[], productionIds: readonly string[]): Promise<void> {
  if (templateIds.length === 0) return;
  const templateSet = new Set(templateIds);
  const productionSet = new Set(productionIds);

  await procs.killBySubject((subject) =>
    subject.kind === "template"
      ? templateSet.has(subject.id)
      : subject.kind === "production" && productionSet.has(subject.id),
  );
}

/**
 * 删除失败后的收尾：进程已经被杀了，库里却还写着「在跑」。
 * 按和后端重启同一套语义把它们标成中断——不是 cancelled，
 * 因为这些对象并没有被删掉，用户还能重跑。
 */
function markStoppedAsInterrupted(templateIds: readonly string[], productionIds: readonly string[]): void {
  if (templateIds.length === 0) return;
  const d = db();
  const now = new Date().toISOString();

  d.transaction(() => {
    d.prepare(
      `UPDATE agent_jobs SET status = 'interrupted', ended_at = COALESCE(ended_at, ?),
              stop_reason = COALESCE(stop_reason, 'delete_aborted')
        WHERE status IN (${marks(ACTIVE_JOB_STATUS.length)})
          AND ((owner_kind = 'template' AND owner_id IN (${marks(templateIds.length)}))
            OR (owner_kind = 'production' AND owner_id IN (${marks(productionIds.length)})))`,
    ).run(now, ...ACTIVE_JOB_STATUS, ...templateIds, ...productionIds);

    if (productionIds.length > 0) {
      // builds 的状态表里没有 interrupted，与 markStaleRunningAsInterrupted 一样落到 failed
      d.prepare(
        `UPDATE builds SET status = 'failed', ended_at = COALESCE(ended_at, ?),
                error_code = COALESCE(error_code, 'DELETE_ABORTED'),
                error_message = COALESCE(error_message, '删除该对象时已中止本次出片，但删除未成功')
          WHERE status IN (${marks(ACTIVE_BUILD_STATUS.length)})
            AND production_id IN (${marks(productionIds.length)})`,
      ).run(now, ...ACTIVE_BUILD_STATUS, ...productionIds);

      d.prepare(
        `UPDATE productions SET status = 'interrupted', updated_at = ?
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
  const existing = directories.filter((dir) => existsSync(dir));
  const moved: Array<{ from: string; to: string }> = [];

  if (existing.length > 0) {
    // mkdir 放在 try 外面：它失败是磁盘或权限问题，不该被包装成「文件被占用」
    mkdirSync(trashRoot(), { recursive: true });
    try {
      for (const dir of existing) {
        const to = path.join(trashRoot(), `${path.basename(dir)}-${Date.now()}`);
        renameTolerantly(dir, to);
        moved.push({ from: dir, to });
      }
    } catch (error) {
      throw new ArchiveError(
        `删除失败：工作目录移不动（${(error as Error).message}）。文件可能被别的程序占用。${restore(moved)}`,
        "DIRECTORY_BUSY",
        409,
      );
    }
  }

  try {
    db().transaction(deleteRows)();
  } catch (error) {
    throw new ArchiveError(
      `删除失败：数据库未能删除记录（${(error as Error).message}）${restore(moved)}`,
      "DB_DELETE_FAILED",
      500,
    );
  }

  // 库已经删干净，目录留着只是垃圾。删不掉也不该把失败报给用户——
  // 对象已经没了，报错只会让人以为还在。留在 .trash 里等下次启动清扫。
  for (const { to } of moved) {
    try {
      rmSync(to, { recursive: true, force: true });
    } catch {
      // 交给 purgeTrash()
    }
  }
}

/**
 * 挪回原处。挪得回就当无事发生；挪不回要把目录去向说出来——
 * 静默吞掉的话，库里还留着记录、目录却已经在 .trash，
 * 侧栏会出现一个 workspace_path 指向不存在目录的模板，用户无从知情。
 */
function restore(moved: ReadonlyArray<{ from: string; to: string }>): string {
  const stranded: string[] = [];
  for (const { from, to } of moved) {
    try {
      if (existsSync(to)) renameTolerantly(to, from);
    } catch {
      stranded.push(to);
    }
  }
  if (stranded.length === 0) return "";
  return `注意：工作目录未能挪回原处，现暂存在 ${stranded.join("、")}，需要手工移回。`;
}

/**
 * Windows 上进程刚退出时文件句柄可能还没释放，rename 会短暂撞 EPERM/EBUSY。
 * 重试几次比直接报「文件被占用」准确得多。
 */
function renameTolerantly(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY")) throw error;
      sleepSync(RENAME_RETRY_DELAY_MS);
    }
  }
}

/** 同步等待：删除整条链路是同步的，不值得为这点重试把它改成异步 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function trashRoot(): string {
  return path.join(config.dataRoot, ".trash");
}

/**
 * 启动时清扫 .trash：上次删除留下的残渣，以及移目录失败后剩的空壳。
 * 不清的话它会一直长，而且没有任何界面入口能看到它。
 */
export function purgeTrash(): number {
  const root = trashRoot();
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    try {
      rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 还被占着就留到下次启动，不值得为它拦住后端起不来
    }
    // 按结果算数而不是按"有没有抛"算：本机实测 rmSync 会对某些路径
    // 既不抛错也不删除（见 DEV-PLAN 已知风险的编码问题），只信 existsSync
    if (!existsSync(full)) removed += 1;
  }
  return removed;
}

function marks(count: number): string {
  return count === 0 ? "NULL" : Array.from({ length: count }, () => "?").join(", ");
}
