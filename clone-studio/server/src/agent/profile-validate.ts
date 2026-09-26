import { db } from "../db/index.js";
import type { ProfileKind } from "./profile-presets.js";

/** 模型档案的输入校验（Spec REQ-010 输入表），从 profiles.ts 拆出来（10.1 第二轮审查 N5） */

export class ProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function cleanName(name: string, selfId?: string): string {
  const value = name.trim();
  // 按字符数：emoji 之类在 UTF-16 里占两个码元
  const length = [...value].length;
  if (length < 1 || length > 30) throw new ProfileError("NAME_INVALID", "档案名要 1-30 字。");
  const taken = db().prepare("SELECT id FROM model_profiles WHERE name = ?").get(value) as { id: string } | undefined;
  if (taken && taken.id !== selfId) throw new ProfileError("NAME_TAKEN", `已经有叫「${value}」的档案了。`, 409);
  return value;
}

export function cleanBaseUrl(kind: ProfileKind, value: string | null | undefined): string | null {
  // Anthropic 官方 key 走官方地址、订阅走本机登录态，都不收 base_url
  if (kind !== "compatible") return null;
  const url = (value ?? "").trim();
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new ProfileError("BASE_URL_INVALID", "base_url 要是 http 或 https 地址。");
  }
  // 请求路径是 base_url 后面接 /v1/messages：带查询串或 # 会拼出坏地址（10.1 第二轮审查 N3）
  if (parsed.search || parsed.hash) {
    throw new ProfileError("BASE_URL_INVALID", "base_url 不能带 ? 查询串或 # 片段。");
  }
  return url.replace(/\/+$/, "");
}

export function cleanModel(value: string): string {
  const model = value.trim();
  if (!model) throw new ProfileError("MODEL_REQUIRED", "要填主模型 id。");
  return model;
}

/**
 * token 只收可见 ASCII（不含空白与控制字符）：真 key 本来就是这样；带换行的会在拼请求头时报错，
 * 而那条报错会把整串明文带回界面（10.1 审查 M2）
 */
export function cleanToken(value: string): string {
  const token = value.trim();
  if (!token) throw new ProfileError("TOKEN_REQUIRED", "要填 API key。");
  if (!/^[!-~]+$/.test(token)) {
    throw new ProfileError("TOKEN_INVALID", "API key 里有空格、换行或其它不可见字符，重新粘贴一次。");
  }
  // 真 key 都比这长；太短的也没法在消息流里可靠地打码（10.2 审查 S2-L2）
  if (token.length < 8) throw new ProfileError("TOKEN_INVALID", "API key 太短，确认复制完整了。");
  return token;
}

export function cleanOptional(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text ? text : null;
}

export function cleanPrice(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new ProfileError("PRICE_INVALID", "单价要是不小于 0 的数。");
  return value;
}
