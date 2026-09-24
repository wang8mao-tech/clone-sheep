/**
 * 批量 brief 的解析与校验（REQ-005 输入表、FLOW-003 边界）：一行一条，空行忽略，
 * 每行 5-500 字（去掉首尾空白后按字符数，中文一个字算一个），一次 1 到上限条（默认 20）。
 * 任何一行不合格或条数超了，整批拒绝、不建任何记录（AC-016）。前端有一份同规则的实时校验，
 * 但以这里为准。
 */

export const BRIEF_MIN = 5;
export const BRIEF_MAX = 500;
export const BATCH_MAX_DEFAULT = 20;

export interface BriefLineError {
  /** 原文里的行号（从 1 起，空行也占号），界面据此标红 */
  line: number;
  length: number;
  problem: "too_short" | "too_long";
}

export type BriefParse =
  | { ok: true; briefs: string[] }
  | { ok: false; code: "EMPTY" | "TOO_MANY" | "BAD_LINES"; message: string; count: number; lines: BriefLineError[] };

/** 字符数：按 Unicode 码点数，emoji 之类不被算成两个 */
export function charCount(text: string): number {
  return [...text].length;
}

export function parseBriefs(text: string, max = BATCH_MAX_DEFAULT): BriefParse {
  const entries = text
    .split(/\r?\n/)
    .map((raw, index) => ({ line: index + 1, text: raw.trim() }))
    .filter((entry) => entry.text.length > 0);
  const count = entries.length;
  if (count === 0) return { ok: false, code: "EMPTY", message: "至少写一条 brief", count, lines: [] };
  if (count > max) {
    return { ok: false, code: "TOO_MANY", message: `一次最多 ${max} 条，现在是 ${count} 条`, count, lines: [] };
  }
  const lines: BriefLineError[] = [];
  for (const entry of entries) {
    const length = charCount(entry.text);
    if (length < BRIEF_MIN) lines.push({ line: entry.line, length, problem: "too_short" });
    else if (length > BRIEF_MAX) lines.push({ line: entry.line, length, problem: "too_long" });
  }
  if (lines.length > 0) {
    const first = lines[0] as BriefLineError;
    const what = first.problem === "too_long" ? `超过 ${BRIEF_MAX} 字（${first.length}）` : `不到 ${BRIEF_MIN} 字`;
    const more = lines.length > 1 ? `，另有 ${lines.length - 1} 行也不合格` : "";
    return { ok: false, code: "BAD_LINES", message: `第 ${first.line} 行${what}${more}`, count, lines };
  }
  return { ok: true, briefs: entries.map((entry) => entry.text) };
}

/** 变体（成片）的默认名称：brief 前 20 字（REQ-007「默认取 brief 前 20 字，可改」），连续空白压成一个 */
export function briefTitle(brief: string): string {
  return [...brief.replace(/\s+/g, " ").trim()].slice(0, 20).join("");
}
