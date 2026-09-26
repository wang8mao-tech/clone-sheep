import type { ModelProfile } from "./model-profiles.js";

/**
 * CMP-010 选档案的规则（REQ-010）：哪些项置灰、为什么；默认选哪个；什么时候提醒「换成了非 Claude 模型」
 */

/** 任务对档案的要求：复刻要看参考视频的帧（看图），变体不强求（只提示） */
export type ProfileNeed = "vision" | null;

/** 这一项为什么不能选；能选是 null */
export function profileBlocker(p: ModelProfile, need: ProfileNeed): string | null {
  if (p.kind !== "subscription" && p.token === null) return "还没有 API key";
  if (need === "vision" && !p.supportsVision) return "不支持看图，复刻要看参考视频的帧";
  return null;
}

/** 默认选中：想要的那个（能选的话）→ 默认档案（能选的话）→ 第一个能选的 */
export function pickProfile(
  list: readonly ModelProfile[],
  need: ProfileNeed,
  preferred?: string | null,
): string | null {
  const usable = list.filter((p) => profileBlocker(p, need) === null);
  return usable.find((p) => p.id === preferred)?.id ?? usable.find((p) => p.isDefault)?.id ?? usable[0]?.id ?? null;
}

/** 走 Claude 的档案（本机订阅、Anthropic key）；其余是别家模型经兼容端点 */
export function isClaudeProfile(p: ModelProfile): boolean {
  return p.kind === "subscription" || p.kind === "anthropic";
}

/** 首次切到非 Claude 档案的提醒（REQ-010 SHOULD）看过没有：只是个人的界面偏好，读写不了就当没看过 */
const SEEN_KEY = "clone-studio.non-claude-notice-seen";

export function nonClaudeNoticeSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markNonClaudeNoticeSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // 存不了就下次再提醒一次，无妨
  }
}
