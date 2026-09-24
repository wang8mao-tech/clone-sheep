import { api } from "./api.js";
import type { AgentJobView } from "./agent.js";
import type { BuildView } from "./build.js";
import type { EstimateRecord } from "./estimate.js";

/** ④ 变体（REQ-005、SCREEN-006）的数据层，形状对着 server/src/services/variants.ts */

export type VariantStatus =
  | "queued"
  | "agent_running"
  | "awaiting_quota"
  | "asset_review"
  | "awaiting_cost_confirm"
  | "building"
  | "done"
  | "failed"
  | "tripped"
  | "interrupted"
  | "cancelled";

export interface VariantView {
  id: string;
  batchId: string | null;
  name: string | null;
  brief: string | null;
  status: VariantStatus;
  createdAt: string;
  updatedAt: string;
  agent: AgentJobView | null;
  estimate: EstimateRecord | null;
  build: BuildView | null;
  needsMe: boolean;
}

export interface BatchView {
  id: string;
  templateId: string;
  note: string | null;
  targetLanguage: string | null;
  limitUsd: number;
  spentUsd: number;
  halted: boolean;
  createdAt: string;
  variants: VariantView[];
}

export interface AgentModelOption {
  id: string | null;
  label: string;
  disabledReason: string | null;
}

export interface SubmitInput {
  briefs: string;
  targetLanguage?: string | null;
  note?: string | null;
  modelId?: string | null;
  budgetUsd?: number | null;
}

export const variantKeys = {
  list: (templateId: string) => ["variants", templateId] as const,
  models: ["agent-models"] as const,
};

export const variantApi = {
  list: (templateId: string) => api.get<{ batches: BatchView[] }>(`/api/templates/${templateId}/variants`),
  models: () => api.get<{ models: AgentModelOption[] }>("/api/agent-models"),
  submit: (templateId: string, input: SubmitInput) =>
    api.post<{ batch: BatchView }>(`/api/templates/${templateId}/batches`, input, 30_000),
  cancel: (id: string) => api.post<{ variant: VariantView }>(`/api/variants/${id}/cancel`, undefined, 30_000),
  rerun: (id: string) => api.post<{ variant: VariantView }>(`/api/variants/${id}/rerun`),
};

/* ── brief 实时校验：规则与 server/src/services/briefs.ts 一致，提交时以后端为准 ── */

export const BRIEF_MIN = 5;
export const BRIEF_MAX = 500;
export const BATCH_MAX = 20;
export const BATCH_NOTE_MAX = 1000;

export interface BriefCheck {
  /** 有效条数（空行不算） */
  count: number;
  /** 不合格的行（原文行号从 1 起，空行也占号）与原因 */
  lines: Array<{ line: number; message: string }>;
  /** 整批的问题（超过条数） */
  batchError: string | null;
}

export function charCount(text: string): number {
  return [...text].length;
}

export function checkBriefs(text: string, max = BATCH_MAX): BriefCheck {
  const entries = text
    .split(/\r?\n/)
    .map((raw, index) => ({ line: index + 1, text: raw.trim() }))
    .filter((e) => e.text.length > 0);
  const lines: BriefCheck["lines"] = [];
  for (const e of entries) {
    const n = charCount(e.text);
    if (n < BRIEF_MIN) lines.push({ line: e.line, message: `第 ${e.line} 行不到 ${BRIEF_MIN} 字` });
    else if (n > BRIEF_MAX)
      lines.push({ line: e.line, message: `第 ${e.line} 行超过 ${BRIEF_MAX} 字（${n}），删短一些` });
  }
  return {
    count: entries.length,
    lines,
    batchError: entries.length > max ? `一次最多 ${max} 条，现在是 ${entries.length} 条` : null,
  };
}

/** SCREEN-006 空状态的三条示例（点击填入） */
export const EXAMPLE_BRIEFS = [
  "换成 2026 年手机品牌排行，毒舌风格，普通话",
  "换成最适合新手的五款咖啡豆，温和科普口吻",
  "换成今年最值得去的国内五座小城，旅行博主口吻",
] as const;

/* ── 队列的筛选与排序（SCREEN-006：五个筛选、需处理置顶）── */

export type VariantFilter = "all" | "mine" | "running" | "done" | "failed";

export const FILTERS: ReadonlyArray<{ key: VariantFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "mine", label: "需要我处理" },
  { key: "running", label: "进行中" },
  { key: "done", label: "完成" },
  { key: "failed", label: "失败" },
];

/** 自己会变的（页面据此轮询）：排队、写稿、等额度、渲染 */
export const RUNNING: ReadonlySet<VariantStatus> = new Set(["queued", "agent_running", "awaiting_quota", "building"]);
/** 停下了、要人决定（「失败」筛选）：失败、熔断、中断 */
export const STOPPED: ReadonlySet<VariantStatus> = new Set(["failed", "tripped", "interrupted"]);

export function matchesFilter(v: VariantView, filter: VariantFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "mine":
      return v.needsMe;
    case "running":
      return RUNNING.has(v.status);
    case "done":
      return v.status === "done";
    case "failed":
      return STOPPED.has(v.status);
  }
}

/** 一批都结束了（完成 / 失败 / 已取消，FLOW-003 完成状态）；熔断、中断还等人决定，不算 */
const FINISHED: ReadonlySet<VariantStatus> = new Set(["done", "failed", "cancelled"]);

export function batchFinished(batch: BatchView): boolean {
  return batch.variants.length > 0 && batch.variants.every((v) => FINISHED.has(v.status));
}

/** 批量全部结束时那条 toast 的文字（Design-Brief §6.2「3 条完成，1 条失败」） */
export function finishSummary(batch: BatchView): string {
  const count = (s: VariantStatus) => batch.variants.filter((v) => v.status === s).length;
  const parts = [`${count("done")} 条完成`];
  if (count("failed")) parts.push(`${count("failed")} 条失败`);
  if (count("cancelled")) parts.push(`${count("cancelled")} 条已取消`);
  return `「${batchName(batch)}」${parts.join("，")}`;
}

/** 批次的称呼：有备注取备注前 20 字，没有就叫「这一批」（toast 与列表的读屏名用） */
export function batchName(batch: BatchView): string {
  const note = batch.note?.trim();
  if (!note) return "这一批";
  const chars = [...note];
  return chars.length > 20 ? `${chars.slice(0, 20).join("")}…` : note;
}

/** 需要人动手的置顶，其余保持提交顺序 */
export function sortForQueue(variants: readonly VariantView[]): VariantView[] {
  return [...variants].sort((a, b) => Number(b.needsMe) - Number(a.needsMe));
}

/** 这一行花了多少（估）：Agent 等价花费 + 已放行的出片估价 */
export function spentOf(v: VariantView): number {
  const agent = v.agent?.costUsd ?? 0;
  // 作废的变体：放行过的估价不再占钱（REQ-005；已提交的出片由服务端计进批次已花，行上只报 Agent 的）
  if (v.status === "cancelled") return agent;
  const released =
    v.estimate && (v.estimate.decision === "auto" || v.estimate.confirmedAt) ? (v.estimate.totalUsd ?? 0) : 0;
  return agent + released;
}
