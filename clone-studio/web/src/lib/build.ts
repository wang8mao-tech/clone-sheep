import { api } from "./api.js";

/** 出片（REQ-006 / CMP-007）的前端数据层，形状对着 server/src/services/build-run.ts */

export interface BuildProgress {
  stage: "submitting" | "working" | "saving";
  phase: string | null;
  stepsDone: number | null;
  stepsTotal: number | null;
  unitsDone: number | null;
  unitsTotal: number | null;
  elapsed: string | null;
  raw: string;
}

export interface BuildContext {
  freeMemBytes: number;
  totalMemBytes: number;
  lastProgress: string | null;
}

export interface BuildView {
  id: string;
  productionId: string;
  status: "running" | "done" | "failed" | "cancelled";
  hypitBuildId: string | null;
  estimateUsd: number | null;
  receiptId: string | null;
  receiptUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  outputPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  context: BuildContext | null;
  progress: BuildProgress | null;
  /** `hypit activity --watch --jsonl` 报的 Runtime 侧阶段计数（status 的进度行没到时也有），只在运行中有 */
  activity: { phases: Record<string, number>; requests: { total: number; completed: number } | null } | null;
}

export const buildKeys = {
  production: (productionId: string) => ["build", productionId] as const,
};

/** 取消要等本地子进程停下再让 hypit 取消，给足余量 */
const CANCEL_TIMEOUT_MS = 60_000;

export const buildApi = {
  get: (productionId: string) => api.get<{ build: BuildView }>(`/api/productions/${productionId}/build`),
  start: (productionId: string) => api.post<{ build: BuildView }>(`/api/productions/${productionId}/build`),
  cancel: (productionId: string) =>
    api.post<{ build: BuildView }>(`/api/productions/${productionId}/build/cancel`, undefined, CANCEL_TIMEOUT_MS),
  retry: (productionId: string) => api.post<{ queued: boolean }>(`/api/productions/${productionId}/build/retry`),
};

/** hypit 的阶段名 → CMP-007 的阶段文字；认不出的返回 null */
function phaseLabel(phase: string): string | null {
  if (/render/.test(phase)) return "渲染";
  if (/encod/.test(phase)) return "编码";
  if (/decod|prepar|browser/.test(phase)) return "准备";
  return null;
}

/** CMP-007 的阶段文字：提交 / 生成素材 n/m / 渲染 / 保存，按 hypit 的阶段名映射 */
export function stageLabel(p: BuildProgress): string {
  if (p.stage === "submitting") return "提交";
  if (p.stage === "saving") return "保存";
  const known = phaseLabel(p.phase ?? "");
  if (known) return known;
  if (p.stepsTotal !== null && p.stepsDone !== null) return `生成素材 ${p.stepsDone}/${p.stepsTotal}`;
  return "进行中";
}

/** 进度行还没到时用 `activity --watch` 的帧：Runtime 正在跑的阶段、或请求完成数；两样都没有就是 null */
export function activityLabel(a: BuildView["activity"]): string | null {
  if (!a) return null;
  const phase = Object.keys(a.phases).find((k) => (a.phases[k] ?? 0) > 0);
  const known = phase ? phaseLabel(phase) : null;
  if (known) return known;
  if (a.requests && a.requests.total > 0) return `生成素材 ${a.requests.completed}/${a.requests.total}`;
  return phase ? "进行中" : null;
}

/** 进度条比例：有帧数按帧，否则按步数；都没有就是 null（不画确定进度） */
export function progressRatio(p: BuildProgress | null): number | null {
  if (!p) return null;
  if (p.unitsTotal && p.unitsDone !== null) return Math.min(p.unitsDone / p.unitsTotal, 1);
  if (p.stepsTotal && p.stepsDone !== null) return Math.min(p.stepsDone / p.stepsTotal, 1);
  return null;
}

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
