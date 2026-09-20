/**
 * 证据准备的纯规则：步骤顺序、时长校验、失败归类。
 *
 * 单独成文件是为了能脱开 hypit 和数据库测——这几条正是 AC-005 与 REQ-002
 * 输入表直接约束的东西，不该只能靠跑一遍真视频来验。
 */

export const EVIDENCE_STEPS = ["fetch", "probe", "transcribe", "tiles"] as const;
export type EvidenceStep = (typeof EVIDENCE_STEPS)[number];

export type EvidenceStatus = "pending" | "running" | "done" | "failed" | "timeout";

/** REQ-002 输入表：时长 3-180 秒（probe 后校验） */
export const MIN_SOURCE_SECONDS = 3;
export const MAX_SOURCE_SECONDS = 180;

/** 单步超时。REQ-002 状态段：单项 >10 分钟标超时可重试 */
export const STEP_TIMEOUT_MS = 10 * 60_000;

export const STEP_LABELS: Record<EvidenceStep, string> = {
  fetch: "获取源视频",
  probe: "探测",
  transcribe: "转写",
  tiles: "抽帧",
};

export interface ProbeFacts {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
}

/**
 * probe 之后的校验。不通过时给的是能直接显示给人看的话，不是错误码。
 *
 * 时长超限按 AC-005 明确说出上限和实际值；没有视频轨的文件根本不能当参考片，
 * 也在这里挡掉——让它走到转写再失败，错误会指向一个看不懂的地方。
 */
export function checkProbe(facts: ProbeFacts): { ok: true } | { ok: false; code: string; message: string } {
  if (!facts.hasVideo) {
    return { ok: false, code: "NO_VIDEO_STREAM", message: "这个文件里没有视频轨，不能作为参考视频。" };
  }
  if (!Number.isFinite(facts.duration) || facts.duration <= 0) {
    return { ok: false, code: "BAD_DURATION", message: "探测不到这个文件的时长，可能已经损坏。" };
  }
  if (facts.duration > MAX_SOURCE_SECONDS) {
    return {
      ok: false,
      code: "DURATION_TOO_LONG",
      message: `时长超过 ${MAX_SOURCE_SECONDS} 秒（实际 ${facts.duration.toFixed(1)} 秒）。`,
    };
  }
  if (facts.duration < MIN_SOURCE_SECONDS) {
    return {
      ok: false,
      code: "DURATION_TOO_SHORT",
      message: `时长不足 ${MIN_SOURCE_SECONDS} 秒（实际 ${facts.duration.toFixed(1)} 秒）。`,
    };
  }
  return { ok: true };
}

/**
 * 没有音轨不算错：REQ-002 没把音轨列为必需，静音片子照样能复刻画面。
 * 但转写会转出空结果，界面该说一声，免得用户以为转写坏了。
 */
export function transcribeNote(facts: ProbeFacts): string | undefined {
  return facts.hasAudio ? undefined : "这个文件没有音轨，转写结果会是空的。";
}

export interface StepView {
  step: EvidenceStep;
  status: EvidenceStatus;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * 整条流水线现在算什么状态。
 *
 * 「哪一步失败停在哪一步」（REQ-002 错误态）意味着：只要有一步失败，
 * 整体就是失败，后面的步骤不该被当作"还没轮到"而显示成等待中。
 */
export function pipelineStatus(steps: readonly StepView[]): "idle" | "running" | "done" | "failed" {
  if (steps.length === 0) return "idle";
  if (steps.some((s) => s.status === "failed" || s.status === "timeout")) return "failed";
  if (steps.every((s) => s.status === "done")) return "done";
  if (steps.some((s) => s.status === "running" || s.status === "done")) return "running";
  return "idle";
}

/** 下一个该跑的步骤。失败时返回失败那一步本身——重试就是从它接着来。 */
export function nextStep(steps: readonly StepView[]): EvidenceStep | undefined {
  const failed = steps.find((s) => s.status === "failed" || s.status === "timeout");
  if (failed) return failed.step;
  return steps.find((s) => s.status === "pending")?.step;
}
