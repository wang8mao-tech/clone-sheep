import { api } from "./api.js";

/** Agent 模型档案（REQ-010、SCREEN-009「Agent 模型」、CMP-010）。对应 server agent/profiles.ts 的视图 */

export type ProfileKind = "subscription" | "anthropic" | "compatible";

export interface ModelProfile {
  id: string;
  name: string;
  kind: ProfileKind;
  baseUrl: string | null;
  modelId: string | null;
  fastModelId: string | null;
  supportsVision: boolean;
  supportsWebSearch: boolean;
  priceIn: number | null;
  priceOut: number | null;
  verifiedAt: string | null;
  isDefault: boolean;
  builtin: boolean;
  /** 打码后的 token；订阅档案是 null */
  token: string | null;
  /** 兼容端点没填全单价：$ 熔断不生效 */
  budgetNote: string | null;
}

export interface ProfilePreset {
  id: string;
  label: string;
  kind: ProfileKind;
  baseUrl: string | null;
  modelId: string;
  fastModelId: string;
  supportsVision: boolean;
  supportsWebSearch: boolean;
  hint: string;
}

export interface ProfileInput {
  name: string;
  kind: ProfileKind;
  baseUrl?: string | null;
  token?: string;
  modelId: string;
  fastModelId?: string | null;
  supportsVision: boolean;
  supportsWebSearch: boolean;
  priceIn?: number | null;
  priceOut?: number | null;
}

export type ProfilePatch = Partial<Omit<ProfileInput, "kind">>;

export interface ProbeResult {
  ok: boolean;
  status?: number;
  detail?: string;
  error?: string;
}

/** 测试连接：服务端最多等上游 60 秒，订阅档案还要起一次 Claude Code */
const PROBE_TIMEOUT_MS = 90_000;

export const profileKeys = {
  list: ["model-profiles"] as const,
  presets: ["model-profiles", "presets"] as const,
};

export const profileApi = {
  list: () => api.get<{ profiles: ModelProfile[] }>("/api/model-profiles"),
  presets: () => api.get<{ presets: ProfilePreset[]; note: string }>("/api/model-profiles/presets"),
  create: (input: ProfileInput) => api.post<{ profile: ModelProfile }>("/api/model-profiles", input),
  update: (id: string, patch: ProfilePatch) => api.patch<{ profile: ModelProfile }>(`/api/model-profiles/${id}`, patch),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/model-profiles/${id}`),
  setDefault: (id: string) => api.post<{ profile: ModelProfile }>(`/api/model-profiles/${id}/default`),
  test: (id: string) =>
    api.post<{ result: ProbeResult; stale: boolean; profile?: ModelProfile }>(
      `/api/model-profiles/${id}/test`,
      undefined,
      PROBE_TIMEOUT_MS,
    ),
};

export const KIND_LABEL: Record<ProfileKind, string> = {
  subscription: "本机订阅",
  anthropic: "Anthropic key",
  compatible: "兼容端点",
};

/** 测试失败的原文：状态码 + 上游响应（或请求本身的错误），界面原样等宽显示 */
export function probeText(result: ProbeResult): string {
  return (
    [result.status ? `HTTP ${result.status}` : null, result.detail, result.error].filter(Boolean).join("\n") ||
    "没有给出原因"
  );
}
