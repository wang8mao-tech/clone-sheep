import { lstatSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { paths } from "../config.js";
import { db } from "../db/index.js";
import { isReallyInside } from "../lib/safe-path.js";
import { ArchiveError } from "./archive.js";
import { coverPathFor } from "./output-meta.js";
import { isListed, requireOutput } from "./output-store.js";

/**
 * 删除成片（REQ-007）：删掉这一条每次出片导出的文件与封面，成片从网格隐藏；花费不动，照 REQ-009 仍计入累计。
 * 只删这一条自己的文件：路径字面与所在目录的真实路径都要在数据根的 clients 下；
 * 目录项是链接就只拆链接本身，不顺着删到外面；不是普通文件（目录之类）的不碰。
 * 还能重来的（失败 / 中断 / 熔断）删了就一并作废：不然「重试出片」「重跑」会把它送回流水线、
 * 重新花钱出一条网格里看不见的片子（9.1 审查 S2-1）。
 */

/** 删成片时一并作废的状态：之后不能再重试出片、重跑、继续 */
const REVIVABLE = ["failed", "interrupted", "tripped"];

/** 流水线里的不许删：渲染中删文件，出完又会写回来 */
const BUSY = new Set([
  "building",
  "queued",
  "awaiting_cost_confirm",
  "agent_running",
  "awaiting_quota",
  "asset_review",
]);

export interface DeleteResult {
  /** 真删掉的文件（本来就不在的不算） */
  removed: string[];
  /** 不在数据根里、或不是文件：没动 */
  skipped: string[];
}

/** 这条成片的出片记录：删之前要先等它们在跑的封面抽取结束 */
export function outputBuildIds(productionId: string): string[] {
  return (db().prepare("SELECT id FROM builds WHERE production_id = ?").all(productionId) as Array<{ id: string }>).map(
    (b) => b.id,
  );
}

/**
 * 删成片：文件都删掉（或本来就没有）之后才标记删除。有一个删不掉（被占用）就抛错、不标记；
 * 前面几次出片的文件可能已经删了，再删一次会把剩下的删完（不在的文件当删过）。
 */
export function deleteOutput(productionId: string): DeleteResult {
  const row = requireOutput(productionId);
  if (!isListed(row.id)) throw new ArchiveError("这条不在成片库里", "OUTPUT_NOT_FOUND", 404);
  if (BUSY.has(row.status)) {
    throw new ArchiveError("这条还在流水线里，先取消或等它结束再删", "OUTPUT_BUSY", 409);
  }
  // 失败 / 中断的复刻片是模板流水线的头：作废它，模板就卡在「复刻中」没有出路了（9.1 第三轮审查 S2-H1）。
  // 它由 ② 重试出片或 ③ 打回来接着走，不从 ⑤ 删
  if (row.kind === "replica" && REVIVABLE.includes(row.status)) {
    throw new ArchiveError("这是模板当前的复刻片，去 ② 重试出片或在 ③ 打回，不在这里删", "REPLICA_IN_FLIGHT", 409);
  }
  const files = (
    db().prepare("SELECT output_path, cover_path FROM builds WHERE production_id = ?").all(row.id) as Array<{
      output_path: string | null;
      cover_path: string | null;
    }>
  ).flatMap((b) => (b.output_path ? [b.output_path, b.cover_path ?? coverPathFor(b.output_path)] : []));

  const result: DeleteResult = { removed: [], skipped: [] };
  for (const file of new Set(files)) {
    const outcome = removeOwnFile(file);
    if (outcome === "removed") result.removed.push(file);
    else if (outcome === "skipped") result.skipped.push(file);
  }
  const now = new Date().toISOString();
  db()
    .prepare(
      `UPDATE productions SET output_deleted_at = ?, updated_at = ?,
              status = CASE WHEN status IN (${REVIVABLE.map(() => "?").join(", ")}) THEN 'cancelled' ELSE status END
        WHERE id = ?`,
    )
    .run(now, now, ...REVIVABLE, row.id);
  return result;
}

/** 删掉了 / 本来就没有 / 不在数据根里或不是文件（不动它） */
function removeOwnFile(file: string): "removed" | "absent" | "skipped" {
  const literal = path.resolve(file);
  // 字面与所在目录的真实路径都得在 clients 下（isReallyInside 两样都比）
  if (!isReallyInside(paths.clients, path.dirname(literal))) return "skipped";
  let info;
  try {
    info = lstatSync(literal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!info.isFile() && !info.isSymbolicLink()) return "skipped";
  // 链接：unlink 只拆链接本身；普通文件：只删这个目录项（有硬链接也不会动到别处的内容）
  try {
    unlinkSync(literal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows 的目录 junction 要用 rmdir 拆（只拆链接，不进目录）
    if (info.isSymbolicLink() && (code === "EPERM" || code === "EISDIR")) {
      rmdirSync(literal);
      return "removed";
    }
    // 文件被别的程序开着（播放器、还在跑的 ffmpeg），或没有删的权限（只读、ACL）：整条不标记，说人话、不带路径
    if (code === "EBUSY" || code === "EPERM") {
      throw new ArchiveError("成片文件被占用或没有删除权限（比如播放器开着），处理之后再删", "OUTPUT_FILE_BUSY", 409);
    }
    throw error;
  }
  return "removed";
}
