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
  /** 未解锁时为什么（AC-012：④ 变体说「先通过验货」）；解锁了是 undefined */
  lockedReason?: string;
}

const LOCKED_REASON: Record<StepKey, string> = {
  reference: "",
  clone: "先完成 ① 参考的证据准备",
  review: "复刻片出好之后才能验货",
  variants: "先通过验货",
  outputs: "先通过验货",
};

export interface StepInput {
  status: TemplateStatus;
  /**
   * 证据准备（下载/探测/转写/抽帧）的整体状态，区分「倒在 ①参考」与「倒在 ②复刻」。
   * 不能用源视频在不在判：下载成功后探测、转写、抽帧任一步失败，源视频已经落盘，
   * 会被错算成 ②复刻 失败（Task 4.4 审查 HIGH，实测）。
   */
  evidenceStatus: "idle" | "running" | "done" | "failed";
}

/**
 * 从模板状态推导五步的状态。
 *
 * 信号是 templates.status（importing / cloning / awaiting_review / approved /
 * failed）加上证据准备的整体状态。子步骤进度在 ①参考 的清单里看，步骤条只到
 * 步骤一级——宁可显示"进行中"，不编一个假的百分比。
 *
 * `failed` 落在哪一步看证据准备：它没完成就是倒在 ①参考，完成了才是倒在 ②复刻。
 *
 * ④变体 与 ⑤成片 由同一道闸门控制：验货「通过」才解锁（REQ-004）。
 * 不看成片数——FLOW-002 的完成状态写明复刻片是在「已验货」那一刻才入库成片的。
 */
export function deriveSteps({ status, evidenceStatus }: StepInput): Step[] {
  const state: Record<StepKey, StepState> = {
    reference: "done",
    clone: "locked",
    review: "locked",
    variants: "locked",
    outputs: "locked",
  };

  switch (status) {
    case "importing":
      // 证据准备已经失败（如后端重启把跑着的步骤标了失败）就别再说「进行中」；
      // 新建的模板也是 importing，还没提交视频时是「可进入」，不是「进行中」
      state.reference = evidenceStatus === "failed" ? "failed" : evidenceStatus === "idle" ? "available" : "running";
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
      // SCOPE-004 / REQ-004：「通过」验货这一个动作同时解锁 ④变体 与 ⑤成片。
      // 验货是质量闸门，没过之前不产出可交付的东西——复刻片在 ③验货 的并排
      // 播放器里看得到，不需要靠 ⑤成片 去看
      state.variants = "available";
      state.outputs = "available";
      break;
    case "failed":
      // 证据准备过了才轮得到 ②复刻 失败；证据还在重跑（模板状态没来得及回到
      // importing 的那一下）就显示 ①参考 进行中，而不是把失败记到 ② 头上
      if (evidenceStatus === "done") {
        state.clone = "failed";
      } else {
        state.reference = evidenceStatus === "running" ? "running" : "failed";
      }
      break;
  }

  return STEP_KEYS.map((key, i) => ({
    key,
    index: i + 1,
    label: STEP_LABELS[key],
    state: state[key],
    enterable: state[key] !== "locked",
    ...(state[key] === "locked" ? { lockedReason: LOCKED_REASON[key] } : {}),
  }));
}

/**
 * 当前该停在哪一步：优先需要人动手的，其次在跑的，再次失败那一步，
 * 最后取能进的最后一步。
 *
 * **每一级都只在可进的步骤里选**，兜底也必须返回一个真的能进的步骤。
 * 调用方（TemplateLayout）的判据是「目标不可进就重定向到这里」——
 * 这里要是返回一个不可进的步骤，就会来回重定向，页面永远停在 <Navigate>
 * 上，页头、步骤条、工作区一个都渲染不出来。今天靠 deriveSteps 从不把
 * reference 设成 locked 这条约定兜着，但那是约定不是代码保证。
 */
export function defaultStep(steps: readonly Step[]): StepKey | undefined {
  const open = steps.filter((s) => s.enterable);
  return (
    open.find((s) => s.state === "attention")?.key ??
    open.find((s) => s.state === "running")?.key ??
    open.find((s) => s.state === "failed")?.key ??
    [...open].reverse()[0]?.key
  );
}

export function isStepKey(value: string | undefined): value is StepKey {
  return STEP_KEYS.includes(value as StepKey);
}
