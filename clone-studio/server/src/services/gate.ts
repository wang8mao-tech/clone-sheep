/**
 * 花钱闸门的判定（REQ-006 规则，AC-017 / 018 / 019）。纯函数：输入估价与限额，输出放行还是等人确认。
 *
 * - 估价 ≤ 单条限额 且 批次已花 + 估价 ≤ 批次限额 → 自动放行
 * - 估价拿不到（plan 失败、Provider 无价目、费率表缺项）→ 一律按超限，等人确认
 * - 批次里有一条已经因为批次限额停下，之后的全部停下（AC-019「该条及之后」），哪怕后面那条更便宜
 *
 * plan 有未解析请求或 preflight 失败不在这里：那种不出片、直接标失败，走不到闸门（见 estimate.ts）。
 */

export type GateReason = "estimate_unknown" | "over_item_limit" | "over_batch_limit" | "batch_halted";

export interface GateInput {
  /** 估价，USD；拿不到是 null */
  estimateUsd: number | null;
  perItemLimitUsd: number;
  /** 属于批次时才有（复刻片没有批次） */
  batch?: {
    limitUsd: number;
    /** 批次里已经放行（自动或人确认）的那些的估价之和 */
    spentUsd: number;
    /** 批次里更早的一条已经因为批次限额停在「待确认花费」 */
    halted: boolean;
  };
}

export type GateDecision = { pass: true } | { pass: false; reasons: GateReason[] };

/** 金额比较留一点余量：0.1 + 0.2 这种浮点和不能把刚好压线的判成超限 */
const EPSILON = 1e-9;

export function decideGate(input: GateInput): GateDecision {
  const reasons: GateReason[] = [];
  const estimate = input.estimateUsd;
  if (estimate === null || !Number.isFinite(estimate) || estimate < 0) {
    reasons.push("estimate_unknown");
  } else {
    if (estimate > input.perItemLimitUsd + EPSILON) reasons.push("over_item_limit");
    if (input.batch && input.batch.spentUsd + estimate > input.batch.limitUsd + EPSILON) {
      reasons.push("over_batch_limit");
    }
  }
  if (input.batch?.halted) reasons.push("batch_halted");
  return reasons.length === 0 ? { pass: true } : { pass: false, reasons };
}

/** 给人看的原因，估价卡与「待确认花费」旁边用 */
export const GATE_REASON_TEXT: Record<GateReason, string> = {
  estimate_unknown: "估价拿不到，按超限处理",
  over_item_limit: "超过单条限额",
  over_batch_limit: "批次已花加上这条会超过批次限额",
  batch_halted: "本批次前面已有一条因批次限额停下，之后的都要人确认",
};
