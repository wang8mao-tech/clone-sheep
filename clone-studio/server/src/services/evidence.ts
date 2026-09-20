import { db } from "../db/index.js";
import { HypitError } from "../hypit/cli.js";
import { ensureWorkspaceLayout } from "../hypit/workspace.js";
import { requireTemplate } from "./archive.js";
import { EVIDENCE_STEPS, nextStep, pipelineStatus, type EvidenceStep, type ProbeFacts } from "./evidence-rules.js";
import { execute, type StepContext } from "./evidence-steps.js";
import {
  ensureSteps,
  listSteps,
  markDone,
  markFailed,
  markRunning,
  resetSteps,
  type StepRecord,
} from "./evidence-store.js";

/**
 * 证据准备流水线（REQ-002）：取源 → 探测 → 转写 → 抽帧。
 *
 * 四步顺序跑，每步状态落库并推 SSE，任一步失败就停在那一步等重试
 * （REQ-002 错误态：哪一步失败停在哪一步）。
 *
 * 跑在后台：HTTP 请求只负责点火并立刻返回当前状态，整条链要好几分钟，
 * 让请求挂着等只会撞上前端 5 秒超时。
 */

export type EvidenceSource = { kind: "file"; path: string } | { kind: "url"; url: string };

export interface EvidenceState {
  templateId: string;
  status: ReturnType<typeof pipelineStatus>;
  steps: StepRecord[];
  sourcePath?: string;
  /** 探测出来的事实，前端拿它显示时长分辨率 */
  probe?: ProbeFacts;
}

/** 同一个模板同时只跑一条流水线。重复点提交不该并排跑两遍。 */
const running = new Set<string>();

export function evidenceState(templateId: string): EvidenceState {
  const template = requireTemplate(templateId);
  const steps = listSteps(templateId);
  const probeStep = steps.find((s) => s.step === "probe");
  return {
    templateId,
    status: pipelineStatus(steps),
    steps,
    ...(template.source_path ? { sourcePath: template.source_path } : {}),
    ...(probeStep?.detail ? { probe: probeStep.detail as ProbeFacts } : {}),
  };
}

export interface StartArgs {
  templateId: string;
  source: EvidenceSource;
  language: string;
  note?: string;
}

/**
 * 开始证据准备。换源视频时四步全部清回 pending——旧的探测结果留着会骗人。
 * 点火后立刻返回，真正的执行在后台。
 */
export function startEvidence(args: StartArgs): EvidenceState {
  const template = requireTemplate(args.templateId);
  if (running.has(args.templateId)) return evidenceState(args.templateId);

  ensureWorkspaceLayout(template.workspace_path as string);
  ensureSteps(args.templateId);
  resetSteps(args.templateId);

  const now = new Date().toISOString();
  db()
    .prepare(
      `UPDATE templates
          SET source_kind = ?, source_url = ?, source_path = NULL, language = ?, note = ?,
              status = 'importing', updated_at = ?
        WHERE id = ?`,
    )
    .run(
      args.source.kind,
      args.source.kind === "url" ? args.source.url : null,
      args.language,
      args.note ?? null,
      now,
      args.templateId,
    );

  void run(args);
  return evidenceState(args.templateId);
}

/**
 * 重试某一步。只允许重试失败或超时的那一步——让人重跑一个已经成功的步骤，
 * 只会把后面已完成的产物弄成半新半旧。
 */
export function retryEvidence(templateId: string, step: EvidenceStep): EvidenceState {
  const template = requireTemplate(templateId);
  if (running.has(templateId)) return evidenceState(templateId);

  const target = listSteps(templateId).find((s) => s.step === step);
  if (!target || (target.status !== "failed" && target.status !== "timeout")) {
    throw new EvidenceError("STEP_NOT_RETRYABLE", `「${step}」这一步现在不是失败状态，不能重试。`, 409);
  }

  void run({
    templateId,
    source: sourceOf(template),
    language: template.language ?? "zh",
    ...(template.note ? { note: template.note } : {}),
    from: step,
  });
  return evidenceState(templateId);
}

export class EvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EvidenceError";
  }
}

function sourceOf(template: ReturnType<typeof requireTemplate>): EvidenceSource {
  if (template.source_kind === "url" && template.source_url) return { kind: "url", url: template.source_url };
  if (template.source_path) return { kind: "file", path: template.source_path };
  throw new EvidenceError("NO_SOURCE", "这个模板还没有参考视频，先提交一个。", 409);
}

/** 后台执行：从 `from` 那一步开始，一路跑到底或停在失败处。 */
async function run(args: StartArgs & { from?: EvidenceStep }): Promise<void> {
  const { templateId } = args;
  if (running.has(templateId)) return;
  running.add(templateId);

  try {
    const template = requireTemplate(templateId);
    const workspace = template.workspace_path as string;
    const startAt = args.from ?? nextStep(listSteps(templateId)) ?? "fetch";
    const begin = EVIDENCE_STEPS.indexOf(startAt);

    for (const step of EVIDENCE_STEPS.slice(begin)) {
      const ok = await runStep(step, { ...args, workspace });
      if (!ok) return;
    }
  } catch (error) {
    // 编排本身炸了（模板没了之类）也要留痕，否则界面永远停在 running
    const steps = listSteps(templateId);
    const stuck = steps.find((s) => s.status === "running")?.step ?? "fetch";
    markFailed(templateId, stuck, {
      code: "PIPELINE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running.delete(templateId);
  }
}

/** 跑一步，成功返回 true。失败已经落库，调用方只需停下来。 */
async function runStep(step: EvidenceStep, ctx: StepContext): Promise<boolean> {
  markRunning(ctx.templateId, step);
  try {
    const detail = await execute(step, ctx);
    markDone(ctx.templateId, step, detail);
    return true;
  } catch (error) {
    markFailed(ctx.templateId, step, classify(error));
    return false;
  }
}

/** 把各种错误归成界面能用的 code + message，hypit 的原文不改写（REQ-002 规则） */
function classify(error: unknown): { code: string; message: string; timedOut?: boolean } {
  if (error instanceof HypitError) {
    return { code: error.code, message: error.message, ...(error.code === "TIMEOUT" ? { timedOut: true } : {}) };
  }
  if (error instanceof EvidenceError) return { code: error.code, message: error.message };
  return { code: "UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
}
