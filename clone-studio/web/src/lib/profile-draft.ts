import type { ModelProfile, ProfileKind, ProfilePreset } from "./model-profiles.js";

/** 模型档案表单的草稿：从预设 / 已有档案填起，提交时转成接口的形状（SCREEN-009 右侧面板） */

export interface Draft {
  name: string;
  kind: ProfileKind;
  baseUrl: string;
  token: string;
  modelId: string;
  fastModelId: string;
  supportsVision: boolean;
  supportsWebSearch: boolean;
  priceIn: string;
  priceOut: string;
}

export type Field = "name" | "baseUrl" | "token" | "modelId" | "price";

/** 服务端错误码落到哪个字段下面（profile-validate.ts 的码） */
export const FIELD_OF: Record<string, Field> = {
  NAME_INVALID: "name",
  NAME_TAKEN: "name",
  BASE_URL_INVALID: "baseUrl",
  TOKEN_REQUIRED: "token",
  TOKEN_INVALID: "token",
  MODEL_REQUIRED: "modelId",
  PRICE_INVALID: "price",
};

export function fromPreset(p: ProfilePreset): Draft {
  return {
    name: p.label,
    kind: p.kind,
    baseUrl: p.baseUrl ?? "",
    token: "",
    modelId: p.modelId,
    fastModelId: p.fastModelId,
    supportsVision: p.supportsVision,
    supportsWebSearch: p.supportsWebSearch,
    priceIn: "",
    priceOut: "",
  };
}

export function fromProfile(p: ModelProfile): Draft {
  return {
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl ?? "",
    token: "",
    modelId: p.modelId ?? "",
    fastModelId: p.fastModelId ?? "",
    supportsVision: p.supportsVision,
    supportsWebSearch: p.supportsWebSearch,
    priceIn: p.priceIn === null ? "" : String(p.priceIn),
    priceOut: p.priceOut === null ? "" : String(p.priceOut),
  };
}

export const price = (text: string): number | null => (text.trim() === "" ? null : Number(text));
