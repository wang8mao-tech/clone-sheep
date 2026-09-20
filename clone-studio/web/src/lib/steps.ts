import type { TemplateStatus } from "./archive.js";

/**
 * 模板页五步流水线（Design-Brief §3 主路径、CMP-001）。
 *
 * 步骤条既是进度也是导航：已解锁的步骤可随时点回去看。
 * 地址里带步骤，刷新才能停在原地（Design-Brief 导航一节）。
 */

export const STEP_KEYS = ["reference", "clone", "review", "variants", "outputs"] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export const STEP_LABELS: Record<StepKey, string> = {
  reference: "参考",
  clone: "复刻",
  review: "验货",
  variants: "变体",
  outputs: "成片",
};

/** CMP-001 的七态 */
export type StepState = "locked" | "available" | "running" | "attention" | "done" | "failed";

export interface Step {
  key: StepKey;
  /** 1-5，步骤条里显示的序号 */
  index: number;
  label: string;
  state: StepState;
  /** 未解锁的步骤不可点（CMP-001：灰、锁图标、不可点） */
  enterable: boolean;
}

export interface StepInput {
  status: TemplateStatus;
  /** 参考视频导入了没有。区分"在导入这一步失败"与"在复刻那一步失败"。 */
  hasSource: boolean;
  /** 已完成的成片数，决定 ⑤成片 有没有东西可看 */
  outputs: number;
}

/**
 * 从模板状态推导五步的状态。
 *
 * Phase 3 只有 templates.status 这一个信号（importing / cloning /
 * awaiting_review / approved / failed），所以推导是粗粒度的：
 * 子步骤进度（fetch → probe → transcribe → 抽帧）要等 Phase 4 才有数据。
 * 这里刻意不猜没有依据的中间态——宁可显示"进行中"，不编一个假的百分比。
 *
 * `failed` 落在哪一步用 hasSource 判：没导进参考视频就是倒在 ①参考，
 * 导进去了就是倒在 ②复刻。这是现有字段能给出的最准的答案。
 */
export function deriveSteps({ status, hasSource, outputs }: StepInput): Step[] {
  const state: Record<StepKey, StepState> = {
    reference: "done",
    clone: "locked",
    review: "locked",
    variants: "locked",
    outputs: "locked",
  };

  switch (status) {
    case "importing":
      state.reference = "running";
      break;
    case "cloning":
      state.clone = "running";
      break;
    case "awaiting_review":
      state.clone = "done";
      // 需要人动手：CMP-001 的琥珀点
      state.review = "attention";
      break;
    case "approved":
      state.clone = "done";
      state.review = "done";
      // SCOPE-004：验货通过才解锁变体
      state.variants = "available";
      break;
    case "failed":
      if (hasSource) {
        state.clone = "failed";
      } else {
        state.reference = "failed";
      }
      break;
  }

  // ⑤成片：有片子就能看，不必等验货通过——复刻片本身也是成片
  if (outputs > 0 && state.outputs === "locked") state.outputs = "available";

  return STEP_KEYS.map((key, i) => ({
    key,
    index: i + 1,
    label: STEP_LABELS[key],
    state: state[key],
    enterable: state[key] !== "locked",
  }));
}

/** 当前该停在哪一步：优先需要人动手的，其次在跑的，再次最后一个能进的 */
export function defaultStep(steps: readonly Step[]): StepKey {
  return (
    steps.find((s) => s.state === "attention")?.key ??
    steps.find((s) => s.state === "running")?.key ??
    steps.find((s) => s.state === "failed")?.key ??
    [...steps].reverse().find((s) => s.enterable)?.key ??
    "reference"
  );
}

export function isStepKey(value: string | undefined): value is StepKey {
  return STEP_KEYS.includes(value as StepKey);
}
