/**
 * `hypit status <id> --watch` 的进度（REQ-006 出片、CMP-007 出片进度）。
 *
 * 两个来源，都是 hypit 自己的稳定形状（packages/cli/src/observation.ts）：
 * - `status --watch`（与 `build --follow` 同一套）往 stderr 刷的行：`  · Working · 1/3 steps complete · 1 rendering frames · 476/900 frames · 4m 41s`
 *   状态词 Submitting / Working / Saving Result，`x/y steps complete`，若干个「n 阶段名 [· x/y frames]」，最后是用时
 * - `activity --watch --jsonl` 的帧：`{ format: "hypit.cli-activity@1", builds: [{ id, work, phases: { "rendering frames": 1 } }] }`
 *
 * 判成败只看最终 JSON 的 `build.result.outcome` / `result.state`，**不看 `work.state`**：失败的 build 也是
 * `work.state: "done"`（Phase 0 实测）。`failure` 是一整段人类可读文本，原样给人。
 */

export type BuildStage = "submitting" | "working" | "saving";

export interface BuildProgress {
  stage: BuildStage;
  /** 阶段名（preparing resources / decoding source frames / starting browsers / rendering frames / encoding video …） */
  phase: string | null;
  stepsDone: number | null;
  stepsTotal: number | null;
  /** 帧进度，只有 rendering / decoding 这类阶段带 */
  unitsDone: number | null;
  unitsTotal: number | null;
  /** hypit 报的用时文字（"4m 41s"），照抄 */
  elapsed: string | null;
  /** 原行，界面「原文」用 */
  raw: string;
}

const STATE: Record<string, BuildStage> = {
  Submitting: "submitting",
  Working: "working",
  "Saving Result": "saving",
};

/** 认得出的进度行返回结构化进度；hypit 的其它 stderr（警告、日志）返回 null */
export function parseProgressLine(line: string): BuildProgress | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("·")) return null;
  const parts = trimmed
    .slice(1)
    .split("·")
    .map((p) => p.trim())
    .filter(Boolean);
  const [state, ...rest] = parts;
  if (!state || !(state in STATE)) return null;
  const progress: BuildProgress = {
    stage: STATE[state] as BuildStage,
    phase: null,
    stepsDone: null,
    stepsTotal: null,
    unitsDone: null,
    unitsTotal: null,
    elapsed: null,
    raw: trimmed,
  };
  for (const part of rest) {
    const steps = /^(\d+)\/(\d+) steps complete$/.exec(part);
    if (steps) {
      progress.stepsDone = Number(steps[1]);
      progress.stepsTotal = Number(steps[2]);
      continue;
    }
    const units = /^(\d+)\/(\d+) (frames|files|items)$/.exec(part);
    if (units) {
      progress.unitsDone = Number(units[1]);
      progress.unitsTotal = Number(units[2]);
      continue;
    }
    if (/^\d+(m \d{2}s|s)$/.test(part)) {
      progress.elapsed = part;
      continue;
    }
    const phase = /^\d+ (.+)$/.exec(part);
    if (phase) progress.phase = phase[1] ?? null;
  }
  return progress;
}

export type BuildOutcome = "complete" | "failed" | "cancelled" | "unknown";

/** 从 `hypit status <id> --watch --json` 最后那份 JSON 判成败。只信 result；work.state 为 done 不代表成功。「需要处理」（attention）时 result 缺失，把它的 message 当失败原文 */
export function judgeBuild(json: unknown): {
  outcome: BuildOutcome;
  buildId: string | null;
  failure: string | null;
  targets: string[];
} {
  const build = (json as { build?: Record<string, unknown> } | null)?.build ?? {};
  const result = (build.result ?? {}) as { outcome?: unknown; state?: unknown };
  const work = (build.work ?? {}) as { outcome?: unknown };
  const attention = build.attention;
  const attentionMessage =
    attention !== null &&
    typeof attention === "object" &&
    "message" in attention &&
    typeof attention.message === "string"
      ? attention.message
      : null;
  const raw = result.outcome ?? result.state ?? work.outcome;
  const outcome: BuildOutcome =
    raw === "complete" ? "complete" : raw === "failed" ? "failed" : raw === "cancelled" ? "cancelled" : "unknown";
  const listed = Array.isArray(build.targets) ? build.targets : ((result as { targets?: unknown }).targets ?? []);
  const targets = Array.isArray(listed) ? listed.filter((t): t is string => typeof t === "string") : [];
  return {
    outcome,
    buildId: typeof build.id === "string" ? build.id : null,
    failure: typeof build.failure === "string" ? build.failure : attentionMessage,
    targets,
  };
}
