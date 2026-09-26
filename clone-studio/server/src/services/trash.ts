import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { ArchiveError } from "./archive.js";

/**
 * 回收区：删除路径上所有碰磁盘的动作。
 *
 * 单独成文件是因为这组操作跟"删哪些库记录"完全正交，而且踩了一串本机特有的
 * 坑（Windows 句柄释放延迟、rmSync 对某些路径静默失败），放一起才好一眼看全。
 */

/** rename 撞 EPERM/EBUSY 时的重试次数与间隔（Windows 句柄释放有延迟） */
const RENAME_RETRIES = 5;
const RENAME_RETRY_DELAY_MS = 120;

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

  let entries: string[];
  try {
    // readdirSync 也得护住：.trash 要是个同名文件（ENOTDIR）或权限异常，
    // 抛出去就顺着 index.ts 的 main().catch 把后端整个拦在启动阶段
    entries = readdirSync(root);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
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
