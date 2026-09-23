import { api } from "./api.js";

/**
 * 估价与花钱闸门（REQ-006）的前端数据层，形状对着 server/src/services/estimate-run.ts 与 routes/estimate.ts。
 * 估价由后端在出片单位排队时自动跑，结论出来推 `template:<id>` / `estimate` 事件，页面据此重拉。
 */

export type RateUnit = "request" | "second";

export interface Rate {
  id: number;
  capability: string;
  endpoint: string | null;
  unit: RateUnit;
  usd: number;
  note: string | null;
  updatedAt: string;
}

export interface RateInput {
  capability: string;
  endpoint?: string | null;
  unit: RateUnit;
  usd: number;
  note?: string | null;
}

export interface EstimateLine {
  capability: string;
  endpoint: string | null;
  count: number;
  unit: RateUnit | null;
  unitUsd: number | null;
  /** 这一组合计；拿不到是 null */
  usd: number | null;
  local: boolean;
  pricingUrl: string | null;
  missing: string | null;
}

export type GateReason = "estimate_unknown" | "over_item_limit" | "over_batch_limit" | "batch_halted";

export interface EstimateRecord {
  id: string;
  productionId: string;
  kind: "ok" | "blocked";
  totalUsd: number | null;
  lines: EstimateLine[];
  reason: string | null;
  decision: "auto" | "confirm" | "blocked";
  reasons: GateReason[];
  confirmedAt: string | null;
  error: string | null;
  pricingUrls: string[];
  createdAt: string;
}

export const GATE_REASON_TEXT: Record<GateReason, string> = {
  estimate_unknown: "估价拿不到，按超限处理",
  over_item_limit: "超过单条限额",
  over_batch_limit: "批次已花加上这条会超过批次限额",
  batch_halted: "本批次前面已有一条因批次限额停下，之后的都要人确认",
};

export const estimateKeys = {
  production: (productionId: string) => ["estimate", productionId] as const,
  rates: ["rates"] as const,
};

/** 估价要跑 plan + pricing（联网），比默认超时长 */
const ESTIMATE_TIMEOUT_MS = 4 * 60_000;

export const estimateApi = {
  get: (productionId: string) => api.get<{ estimate: EstimateRecord }>(`/api/productions/${productionId}/estimate`),
  reestimate: (productionId: string) =>
    api.post<{ estimate: EstimateRecord }>(`/api/productions/${productionId}/estimate`, undefined, ESTIMATE_TIMEOUT_MS),
  confirm: (productionId: string) =>
    api.post<{ estimate: EstimateRecord }>(`/api/productions/${productionId}/confirm-cost`),
  rates: () => api.get<{ rates: Rate[] }>("/api/settings/rates"),
  saveRate: (input: RateInput) => api.put<{ rate: Rate }>("/api/settings/rates", input),
  deleteRate: (id: number) => api.delete<{ ok: boolean }>(`/api/settings/rates/${id}`),
};

/** 能力名太长（`@hypit/seedance@1#seedance-2-mini`）：卡片上只显示 `#` 后面的名字，悬停给全名 */
export function capabilityLabel(capability: string): string {
  const hash = capability.lastIndexOf("#");
  return hash >= 0 ? capability.slice(hash + 1) : capability;
}
