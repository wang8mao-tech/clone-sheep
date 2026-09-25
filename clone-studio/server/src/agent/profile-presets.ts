/**
 * 模型档案的内置档案与预设（Spec REQ-010）。端点与模型 id 都是 2026-09-25 联网核实过的（DEV-PLAN Phase 10「联网核实」）：
 * - DeepSeek：api-docs.deepseek.com 的 Claude Code 接入与 Anthropic API 两页，图片块与 web_search 工具都写明支持
 * - 豆包方舟：火山方舟官方文档「Coding Plan 个人版」，`/api/coding` 只消耗 Coding Plan 额度；`/api/v3` 另行计费、不是 Anthropic 协议
 * - Gemini / OpenAI：没有原生 Anthropic 兼容端点，经用户本机自起的 LiteLLM 代理（本应用不内置、不托管）
 */

export type ProfileKind = "subscription" | "anthropic" | "compatible";

export const SUBSCRIPTION_PROFILE_ID = "subscription";
export const SUBSCRIPTION_PROFILE_NAME = "本机 Claude Code 订阅";

/** 预设旁固定的一行（REQ-010 MUST） */
export const API_KEY_ONLY_NOTE = "需要 API key，聊天订阅不可用";

export interface ProfilePreset {
  id: "subscription-model" | "anthropic" | "deepseek" | "ark" | "litellm-gemini" | "litellm-openai" | "custom";
  label: string;
  kind: ProfileKind;
  /** Anthropic 官方 key 不填 base_url（走官方地址） */
  baseUrl: string | null;
  modelId: string;
  fastModelId: string;
  supportsVision: boolean;
  supportsWebSearch: boolean;
  /** 设置页添加面板上的补充说明 */
  hint: string;
}

export const PROFILE_PRESETS: readonly ProfilePreset[] = [
  {
    id: "subscription-model",
    label: "本机订阅 · 指定模型",
    kind: "subscription",
    baseUrl: null,
    modelId: "claude-sonnet-5",
    fastModelId: "",
    supportsVision: true,
    supportsWebSearch: true,
    hint: "同样走本机 Claude Code 登录态、不用 key，只指定用哪个模型（内置的订阅档案用订阅的默认模型）。",
  },
  {
    id: "anthropic",
    label: "Anthropic API key",
    kind: "anthropic",
    baseUrl: null,
    modelId: "claude-sonnet-5",
    fastModelId: "claude-haiku-4-5-20251001",
    supportsVision: true,
    supportsWebSearch: true,
    hint: "走 Anthropic 官方地址按量计费，花费按官方价估算。",
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
    hint: "官方 Anthropic 兼容端点；填 DeepSeek 开放平台的 API key。",
  },
  {
    id: "ark",
    label: "豆包 / 火山方舟",
    kind: "compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    modelId: "ark-code-latest",
    fastModelId: "ark-code-latest",
    supportsVision: false,
    supportsWebSearch: false,
    hint: "方舟 Coding Plan 的 Anthropic 兼容端点，只消耗 Coding Plan 额度；ark-code-latest 用控制台里选的模型。看图随所选模型，确认支持再打开。",
  },
  {
    id: "litellm-gemini",
    label: "Gemini（经 LiteLLM）",
    kind: "compatible",
    baseUrl: "http://127.0.0.1:4000",
    modelId: "",
    fastModelId: "",
    supportsVision: true,
    supportsWebSearch: false,
    hint: "Gemini 没有 Anthropic 兼容端点：先在本机起 LiteLLM 代理（litellm --model gemini/<模型> --port 4000），模型 id 填代理里配的名字，key 填代理的 key。",
  },
  {
    id: "litellm-openai",
    label: "ChatGPT / OpenAI（经 LiteLLM）",
    kind: "compatible",
    baseUrl: "http://127.0.0.1:4000",
    modelId: "",
    fastModelId: "",
    supportsVision: true,
    supportsWebSearch: false,
    hint: "OpenAI 没有 Anthropic 兼容端点：先在本机起 LiteLLM 代理（litellm --model openai/<模型> --port 4000），模型 id 填代理里配的名字，key 填代理的 key。",
  },
  {
    id: "custom",
    label: "自定义",
    kind: "compatible",
    baseUrl: "",
    modelId: "",
    fastModelId: "",
    supportsVision: false,
    supportsWebSearch: false,
    hint: "任意 Anthropic 兼容端点（Messages API）。",
  },
];
