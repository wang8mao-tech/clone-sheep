import { api } from "./api.js";
import type { AgentJobView } from "./agent.js";

/**
 * ② 复刻（REQ-004 / SCREEN-004）的前端数据层，形状对着 server/src/routes/clone.ts。
 *
 * 文件由 Agent 在运行中陆续写出来，后端没有「写了哪个文件」的事件：任务在跑（或完成后还在核判据）时
 * 页面按间隔重拉，判据结论出来时后端往 `template:<id>` 推一条 `clone` 事件让它立刻失效。
 */

export interface CloneFile {
  text: string;
  /** 超过 256 KB 被截断给页面；Agent 读的是磁盘上的全文 */
  truncated: boolean;
}

export interface CloneVerdict {
  jobId: string;
  /** 核的是这个任务哪一次完成（继续之后同一个任务会再完成一次） */
  jobEndedAt: string | null;
  ok: boolean;
  missing: string[];
  /** `hypit check --json` 的原样输出；reference.svrun 缺了就没跑，是 null */
  check: unknown;
  error: string | null;
  createdAt: string;
}

export interface CloneState {
  templateId: string;
  analysis: CloneFile | null;
  timeline: CloneFile | null;
  svrunExists: boolean;
  /** 只给和当前这次运行对得上的结论；继续 / 新一轮之后是 null */
  verdict: CloneVerdict | null;
  /** 任务完成了、宿主还在核判据 */
  verifying: boolean;
  replica: { id: string; version: number; status: string; updatedAt: string } | null;
}

export const cloneKeys = {
  state: (templateId: string) => ["clone", templateId] as const,
};

export const cloneApi = {
  state: (templateId: string) => api.get<CloneState>(`/api/templates/${templateId}/clone`),
  /** 手动开始：导入早于自动启动上线的模板，或自动启动没起来时用 */
  start: (templateId: string) => api.post<{ job: AgentJobView }>(`/api/templates/${templateId}/clone`),
};

export interface TimelineRow {
  /** 秒 */
  start: number;
  end: number | null;
  /** 页面显示的时间码，按 formatTimecode 压紧 */
  label: string;
  /** 这一段的说明；紧随其后、不带时间码的行（子弹、续行）并进来，不丢 */
  text: string;
}

/** mm:ss、mm:ss.s、h:mm:ss.s */
const TIME = String.raw`((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?)`;
/** 行首允许的包装：标题井号、列表符 / 序号、表格竖线（含序号列）、方括号、反引号、粗体 */
const LEAD = String.raw`^\s*(?:#{1,6}\s+)?(?:[-*+]\s+|\d+[.)]\s+)?(?:\|\s*(?:\d+\s*\|\s*)?)?[\[\x60*]*\s*`;
const RANGE = String.raw`(?:\s*(?:[-–—~]|->|→|至|到)\s*${TIME})?`;
const ROW = new RegExp(`${LEAD}${TIME}${RANGE}\\s*[\\]\\x60*]*\\s*[|:：·、,，-]?\\s*(.*)$`);

/** mm:ss、mm:ss.s 或 h:mm:ss.s → 秒 */
export function parseTimecode(value: string): number {
  return value
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
}

/**
 * 页面上的时间码：Agent 按提示写 `mm:ss.s`，整秒的 `.0` 去掉，`00:00.0-00:03.5` 显示成 `00:00-00:03.5`；
 * 带小时的照原样
 */
export function formatTimecode(value: string): string {
  return value.replace(/\.0+$/, "");
}

function cleanText(raw: string): string {
  return raw
    .replace(/\s*\|\s*$/, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\*\*/g, "")
    .trim();
}

/**
 * TIMELINE.md → 带时间码的行。复刻提示要求每段写「mm:ss.s 起止 + 这一段在做什么」，但 Agent 写成列表、表格、
 * 标题还是纯行都有可能：认得出时间码开头的行就收；时间码行之后不带时间码的行（子弹、续行）并进上一行的说明，
 * 不丢内容；开头的标题、表头、说明跳过。一行都认不出时返回空数组，页面退回按 markdown 原样渲染。
 */
export function parseTimeline(markdown: string): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = ROW.exec(line);
    if (match) {
      const [, from = "", to, rest = ""] = match;
      rows.push({
        start: parseTimecode(from),
        end: to ? parseTimecode(to) : null,
        label: to ? `${formatTimecode(from)}-${formatTimecode(to)}` : formatTimecode(from),
        text: cleanText(rest),
      });
      continue;
    }
    const last = rows.at(-1);
    if (!last) continue;
    // 没带时间码的表格行（表头、分隔行）、标题、空行是结构不是内容；其余（子弹、续行）并进上一段
    if (/^\s*[|#]/.test(line)) continue;
    const extra = cleanText(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
    if (!extra || /^[-:· ]+$/.test(extra)) continue;
    last.text = last.text ? `${last.text} · ${extra}` : extra;
  }
  return rows;
}

export interface AnalysisParts {
  /** 「不确定项」的条目之外的全部正文，按 markdown 渲染 */
  body: string;
  /** 「不确定项」一节里的逐条内容（REQ-004：人验货时特别看的地方），续行并进条目 */
  uncertain: string[];
}

/**
 * 把 ANALYSIS.md「不确定项」一节的**条目**拆出来单独标琥珀徽标（设计稿 ② 复刻）。
 * 那一节里的引言段落、条目的缩进续行都不丢：段落留在正文，续行并进条目。
 */
export function splitAnalysis(markdown: string): AnalysisParts {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s.*不确定项/.test(l));
  if (start < 0) return { body: markdown, uncertain: [] };
  const level = /^(#+)/.exec(lines[start] ?? "")?.[1]?.length ?? 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const heading = /^(#+)\s/.exec(lines[i] ?? "");
    if (heading && (heading[1]?.length ?? 0) <= level) {
      end = i;
      break;
    }
  }
  const uncertain: string[] = [];
  const kept: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)?.[1]?.trim();
    if (item) uncertain.push(item);
    else if (/^\s+\S/.test(line) && uncertain.length) uncertain[uncertain.length - 1] += ` ${line.trim()}`;
    else kept.push(line);
  }
  // 那一节写成了段落而不是列表：拆不出条目时 kept 就是整节，原样留在正文里
  const section = kept.some((l) => l.trim()) ? [lines[start] ?? "", ...kept] : [];
  const body = [...lines.slice(0, start), ...section, ...lines.slice(end)].join("\n").trim();
  return { body, uncertain };
}
