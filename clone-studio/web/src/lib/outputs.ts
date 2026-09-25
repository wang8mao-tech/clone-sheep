import { describeStop } from "./agent-status.js";
import { api } from "./api.js";
import type { BuildView } from "./build.js";

/** ⑤ 成片库（REQ-007、REQ-009、SCREEN-008）的数据层，形状对着 server/src/services/outputs.ts 与 output-costs.ts */

export type OutputStatus = "done" | "building" | "pending" | "failed" | "cancelled" | "interrupted";

export interface OutputView {
  id: string;
  kind: "replica" | "variant";
  name: string;
  version: number;
  status: OutputStatus;
  /** 出片单位的原始状态（queued / agent_running / asset_review / awaiting_cost_confirm / tripped …） */
  productionStatus: string;
  /** 复刻片旧版：已被第几版取代 */
  supersededBy: number | null;
  approved: boolean;
  durationS: number | null;
  coverUrl: string | null;
  costUsd: number;
  costIsEstimate: boolean;
  /** 完成且文件还在：能播放、下载、打包 */
  downloadable: boolean;
  /** 能重试出片（服务端与 build/retry 同一套判断，含「重跑后运行文件已清掉」） */
  retryable: boolean;
  /** 停在哪一步、原文（服务端按 ④ stopReason 的顺序算好）；没停下是 null */
  stop: { step: "estimate" | "build" | "agent"; text: string; reason?: string | null } | null;
  build: BuildView | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCostLine {
  jobId: string;
  model: string | null;
  status: string;
  elapsedMs: number;
  costUsd: number;
  isEstimate: boolean;
  /** 复刻片的复刻会话挂在模板上、各版本共用：列出来，不计入这一条的合计 */
  shared: boolean;
  createdAt: string;
}

export interface BuildCostLine {
  buildId: string;
  hypitBuildId: string | null;
  channel: string | null;
  model: string | null;
  status: string;
  estimateUsd: number | null;
  actualUsd: number | null;
  costUsd: number;
  isEstimate: boolean;
  receiptId: string | null;
  receiptUrl: string | null;
  createdAt: string;
}

export interface OutputCosts {
  productionId: string;
  agent: AgentCostLine[];
  builds: BuildCostLine[];
  totalUsd: number;
  totalIsEstimate: boolean;
}

export const outputKeys = {
  list: (templateId: string) => ["outputs", templateId] as const,
  costs: (productionId: string) => ["output-costs", productionId] as const,
};

const id = (s: string) => encodeURIComponent(s);

export const outputApi = {
  /** 第一次打开要抽封面帧、读时长（ffmpeg），给足时间 */
  list: (templateId: string) => api.get<{ outputs: OutputView[] }>(`/api/templates/${id(templateId)}/outputs`, 60_000),
  rename: (productionId: string, name: string) =>
    api.patch<{ id: string; name: string }>(`/api/productions/${id(productionId)}`, { name }),
  costs: (productionId: string) => api.get<OutputCosts>(`/api/productions/${id(productionId)}/costs`),
  remove: (productionId: string) =>
    api.delete<{ removed: number; skipped: number }>(`/api/productions/${id(productionId)}/output`),
};

export const videoUrl = (productionId: string) => `/api/productions/${id(productionId)}/video`;
export const downloadUrl = (productionId: string) => `${videoUrl(productionId)}?download=1`;
export const zipUrl = (templateId: string, ids: readonly string[]) =>
  `/api/templates/${id(templateId)}/outputs/zip?ids=${ids.map(id).join(",")}`;

export type OutputFilter = "all" | "done" | "running" | "failed";

export const OUTPUT_FILTERS: ReadonlyArray<{ key: OutputFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "done", label: "完成" },
  { key: "running", label: "进行中" },
  { key: "failed", label: "失败" },
];

export function matchesOutput(o: OutputView, filter: OutputFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "done":
      return o.status === "done";
    case "running":
      return o.status === "building" || o.status === "pending";
    case "failed":
      return o.status === "failed" || o.status === "interrupted" || o.status === "cancelled";
  }
}

/**
 * 只有渲染中（进度只在内存里、不推事件）和排队等估价的才轮询；等人（素材待审、待确认花费）、写稿中的
 * 状态变化都有 variants / estimate / build 事件推过来，不用每 3 秒重拉（9.2 第二轮审查 S2-1）
 */
export function shouldPoll(outputs: readonly OutputView[]): boolean {
  return outputs.some((o) => o.status === "building" || (o.status === "pending" && o.productionStatus === "queued"));
}

/** 服务端一定会拒的删除：流水线里的（排队、写稿、待审、待确认、渲染中）、失败 / 中断的复刻片（REQ-007） */
export function deleteBlocked(o: OutputView): string | null {
  if (o.status === "building" || o.status === "pending") return "还在流水线里，等它结束或在 ④ 取消之后再删";
  if (o.kind === "replica" && (o.status === "failed" || o.status === "interrupted")) {
    return "这是模板当前的复刻片，去 ② 重试出片或在 ③ 打回";
  }
  return null;
}

/** 停在出片这一步、可以「重试出片」：服务端算好的（同 build/retry 的判断），前端不再自己猜（9.2 第三轮审查 S1-1） */
export function retryable(o: OutputView): boolean {
  return o.retryable;
}

/** 停因的显示文字：Agent 那一段的原始停因用 ④ 同一个 describeStop 翻成人话（9.2 第五轮审查 S1-M3） */
export function stopText(stop: NonNullable<OutputView["stop"]>): string {
  if (stop.step !== "agent" || !stop.reason) return stop.text;
  const why = describeStop({ status: "failed", stopReason: stop.reason });
  return why ? `${stop.text}：${why}` : stop.text;
}

/**
 * 停下之后该去哪儿接着做（Design-Brief §6.2「再给能做的动作」）：能重试出片的就在这里重试，不另指路；
 * 估价没过：变体在 ④ 的素材审核面板里重新估价，复刻片在 ② 复刻页；Agent 那一段停下（只有变体有）：去 ④ 继续或重跑
 */
export function nextStepHint(o: OutputView): string | null {
  if (!o.stop || o.retryable) return null;
  if (o.stop.step === "estimate") {
    return o.kind === "variant" ? "去 ④ 打开这条变体的素材审核，重新估价。" : "去 ② 复刻页重新估价。";
  }
  if (o.stop.step === "agent") return "停在 Agent 写稿这一段，去 ④ 变体队列继续或重跑。";
  return null;
}

/** 卡片上的时长：m:ss；取不到给「—」 */
export function formatClipSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
