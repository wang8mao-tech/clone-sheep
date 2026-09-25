import { vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { healthStubs, stubFetch } from "./harness.js";
import type { ModelProfile, ProfilePreset } from "../lib/model-profiles.js";

/** 设置页「Agent 模型」测试的公共件（Task 10.3）：档案与预设样例、后端桩、找行、挂起请求 */

export const settings = {
  perItemLimitUsd: 1.5,
  batchLimitUsd: 15,
  agentTimeoutMinutes: 45,
  agentBudgetUsd: 5,
  agentConcurrency: 2,
  renderConcurrency: 1,
  renderWorkers: 1,
  referenceMaxSeconds: 180,
  batchMaxItems: 50,
  codexProviderEnabled: false,
  updatedAt: "2026-09-20T04:00:00.000Z",
  paths: { dataRoot: "C:/data", hypitRoot: "C:/hypit", secrets: "C:/data/secrets.json" },
  credentials: { tokendance: null, hypihub: null, tokendanceVerifiedAt: null, hypihubVerifiedAt: null },
};

export const SUB: ModelProfile = {
  id: "subscription",
  name: "本机 Claude Code 订阅",
  kind: "subscription",
  baseUrl: null,
  modelId: null,
  fastModelId: null,
  supportsVision: true,
  supportsWebSearch: true,
  priceIn: null,
  priceOut: null,
  verifiedAt: null,
  isDefault: true,
  builtin: true,
  token: null,
  budgetNote: null,
};

export const DS: ModelProfile = {
  ...SUB,
  id: "p-ds",
  name: "DeepSeek",
  kind: "compatible",
  baseUrl: "https://api.deepseek.com/anthropic",
  modelId: "deepseek-flash",
  supportsWebSearch: false,
  isDefault: false,
  builtin: false,
  token: "sk-••••••••••••abcd",
  budgetNote: "没填单价：$ 熔断不生效，只靠时长与卡死检测",
};

export const PRESETS: ProfilePreset[] = [
  {
    id: "subscription-model",
    label: "本机订阅 · 指定模型",
    kind: "subscription",
    baseUrl: null,
    modelId: "claude-sonnet-5",
    fastModelId: "",
    supportsVision: true,
    supportsWebSearch: true,
    hint: "走本机登录态",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "compatible",
    baseUrl: "https://api.deepseek.com/anthropic",
    modelId: "deepseek-flash",
    fastModelId: "deepseek-flash",
    supportsVision: true,
    supportsWebSearch: true,
    hint: "官方 Anthropic 兼容端点",
  },
];

type Stub = Parameters<typeof stubFetch>[0];

export function stub(profiles: ModelProfile[], extra: Stub = {}) {
  stubFetch({
    ...healthStubs,
    "/api/clients": { body: { clients: [] } },
    "/api/settings": { body: settings },
    "/api/settings/rates": { body: { rates: [] } },
    "/api/model-profiles": { body: { profiles } },
    "/api/model-profiles/presets": { body: { presets: PRESETS, note: "需要 API key，聊天订阅不可用" } },
    ...extra,
  });
}

export const section = async () => {
  const list = await screen.findByRole("list", { name: "模型档案" });
  return list;
};
export const row = (list: HTMLElement, name: string) =>
  within(list)
    .getAllByRole("listitem")
    .find((li) => li.textContent?.includes(name)) as HTMLElement;

/** 把命中的请求挂起，手动放行：验「进行中」的样子 */
export function hold(match: (url: string, method: string) => boolean) {
  const inner = globalThis.fetch;
  const pending: Array<() => void> = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!match(url, (init?.method ?? "GET").toUpperCase())) return inner(input, init);
    return new Promise<Response>((resolve) => pending.push(() => void inner(input, init).then(resolve)));
  });
  return { releaseAll: () => pending.splice(0).forEach((go) => go()), count: () => pending.length };
}
