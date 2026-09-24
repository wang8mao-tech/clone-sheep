import { rm } from "node:fs/promises";
import { db } from "../db/index.js";
import { HypitError } from "../hypit/cli.js";
import { ensureWorkspaceLayout } from "../hypit/workspace.js";
import { requireTemplate } from "./archive.js";
import { activeJobsOf, activeVariantJobsOf } from "../agent/job-store.js";
import { requestClone } from "./clone-starter.js";
import { cancelOpenReplicas, isBuilding } from "./replicas.js";
import { EVIDENCE_STEPS, nextStep, pipelineStatus, type EvidenceStep, type ProbeFacts } from "./evidence-rules.js";
import { execute, tilesDirOf, transcriptPathOf } from "./evidence-steps.js";
import {
  ensureSteps,
  listSteps,
  markDone,
  markFailed,
  markRunning,
  resetSteps,
  type StepRecord,
} from "./evidence-store.js";
import { EvidenceError, type EvidenceSource, type StartArgs } from "./evidence-types.js";

/**
 * 证据准备流水线（REQ-002）：取源 → 探测 → 转写 → 抽帧。
 *
 * 四步顺序跑，每步状态落库并推 SSE，任一步失败就停在那一步等重试
 * （REQ-002 错误态：哪一步失败停在哪一步）。
 *
 * 跑在后台：HTTP 请求只负责点火并立刻返回当前状态，整条链要十几秒到几分钟，
 * 让请求挂着等只会撞上前端的超时。
 */

export { EvidenceError } from "./evidence-types.js";
export type { EvidenceSource, StartArgs } from "./evidence-types.js";

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

/**
 * 开始证据准备。换源视频时四步清回 pending，**磁盘上的旧产物也要一起清**——
 * 只清库的话，新源在 fetch 就失败时，工作目录里留着的是上一条视频的转写和拼图，
 * 而库里显示全部 pending。Phase 5 的 Agent 直接读工作目录，会拿这份错证据去复刻。
 *
 * 点火后立刻返回，真正的执行在后台。
 */
export async function startEvidence(args: StartArgs): Promise<EvidenceState> {
  const template = requireTemplate(args.templateId);
  assertNotRunning(args.templateId);

  const workspace = requireWorkspace(template);
  ensureWorkspaceLayout(workspace);
  ensureSteps(args.templateId);
  resetSteps(args.templateId);
  await rm(transcriptPathOf(workspace), { force: true });
  await rm(tilesDirOf(workspace), { recursive: true, force: true });

  const now = new Date().toISOString();
  db()
    .prepare(
      `UPDATE templates
          SET source_kind = ?, source_url = ?, source_path = NULL, language = ?, note = ?,
              status = 'importing', approved_replica_id = NULL, updated_at = ?
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

  // 旧参考视频的复刻片不能留着等估价：新证据哪怕失败，也不能让一条按旧稿子排队的复刻片被自动出片。
  // 必须在模板离开 cloning 之后作废：上面的 rm 要 await，正在核的那一轮若在这个空当里核完，看到的
  // 还是 cloning，会再建一条排队的复刻片（Task 6.1 第三轮审查复现的竞态）
  cancelOpenReplicas(args.templateId);
  void run(args);
  return evidenceState(args.templateId);
}

/**
 * 重试某一步。只允许重试失败或超时的那一步——让人重跑一个已经成功的步骤，
 * 只会把后面已完成的产物弄成半新半旧。
 */
export function retryEvidence(templateId: string, step: EvidenceStep): EvidenceState {
  const template = requireTemplate(templateId);
  assertNotRunning(templateId);

  const target = listSteps(templateId).find((s) => s.step === step);
  if (!target || (target.status !== "failed" && target.status !== "timeout")) {
    throw new EvidenceError("STEP_NOT_RETRYABLE", `「${step}」这一步现在不是失败状态，不能重试。`, 409);
  }

  // 与 startEvidence 一致：重跑期间模板回到 importing。留在 failed 的话，步骤条拿到
  // 「模板失败 + 证据在跑」，会把失败记到 ②复刻 头上，还把进模板页的人送过去
  // （Task 4.4 复审 HIGH，实测转写重试冷启动要跑 80 秒）
  setTemplateStatus(templateId, "importing");
  void run({
    templateId,
    source: sourceOf(template),
    language: template.language ?? "zh",
    ...(template.note ? { note: template.note } : {}),
    from: step,
  });
  return evidenceState(templateId);
}

/**
 * 正在跑时拒绝新请求，而不是静默返回当前状态。
 * 静默的话，用户换了个新链接点提交，拿到 200 和一份仍在跑旧视频的状态，
 * 无从分辨「我的提交被忽略了」。
 */
function assertNotRunning(templateId: string): void {
  if (running.has(templateId)) {
    throw new EvidenceError("EVIDENCE_BUSY", "这个模板的证据准备还在跑，等它结束或先重试失败的那一步。", 409);
  }
  // 复刻 Agent 正在读这些证据：这时清掉转写和拼图，它会拿半新半旧的证据写完，新导入也起不了新任务
  if (activeJobsOf("template", templateId).length > 0) {
    throw new EvidenceError("AGENT_ACTIVE", "这个模板的复刻任务还在跑，先在右侧抽屉中止它再换参考视频。", 409);
  }
  // 变体会话以这份模板为原稿、可能回头读证据：它们在跑时同样不能换（Task 5.2 复审 S2-L7）
  if (activeVariantJobsOf(templateId).length > 0) {
    throw new EvidenceError("VARIANTS_ACTIVE", "这个模板下还有变体任务在跑，先在 ④ 变体里取消它们再换参考视频。", 409);
  }
  // 复刻片正在渲染：它读的是这份 reference.svrun 和证据，换掉会让渲染中的那条出错（6.1 只作废未出片的）
  if (isBuilding(templateId)) {
    throw new EvidenceError("BUILD_ACTIVE", "这个模板的复刻片正在出片，等它结束或先取消出片再换参考视频。", 409);
  }
}

function requireWorkspace(template: ReturnType<typeof requireTemplate>): string {
  if (!template.workspace_path) {
    throw new EvidenceError("NO_WORKSPACE", "这个模板没有工作目录，无法导入参考视频。", 409);
  }
  return template.workspace_path;
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
    const workspace = requireWorkspace(template);
    const maxSeconds = readMaxSeconds();
    const startAt = args.from ?? nextStep(listSteps(templateId)) ?? "fetch";
    const begin = EVIDENCE_STEPS.indexOf(startAt);

    for (const step of EVIDENCE_STEPS.slice(begin)) {
      const ok = await runStep(step, { ...args, workspace, maxSeconds });
      if (!ok) {
        setTemplateStatus(templateId, "failed");
        return;
      }
    }
    // 四步都过了。REQ-002 状态段的「成功→自动进入复刻」：状态推到 cloning，
    // 再请复刻编排起 Agent（clone-starter.ts 注册点；只在这一刻触发，已有模板不补跑）
    setTemplateStatus(templateId, "cloning");
    requestClone(templateId);
  } catch (error) {
    // 收尾本身也可能炸（库已关、磁盘满）。run() 是 void 调用的游离 Promise，
    // 让它抛出去就是一条未捕获拒绝——Node 默认会因此结束进程。宁可丢掉这条
    // 错误记录，也不能把整个后端带走
    try {
      markPipelineFailure(templateId, error);
    } catch {
      // 状态留在 running，由下次启动的 markStaleRunningAsInterrupted 兜底
    }
  } finally {
    running.delete(templateId);
  }
}

/**
 * 编排本身炸了（模板没了、工作目录没了之类）也要留痕，否则界面永远停在 running。
 *
 * 落在「第一个还没完成的步骤」上，不能落在写死的 fetch：异常若发生在任何
 * markRunning 之前，写死 fetch 会把一个**已经成功的** fetch 改写成 failed，
 * 而重试 fetch 又会去动源视频。
 */
function markPipelineFailure(templateId: string, error: unknown): void {
  const steps = listSteps(templateId);
  const stuck =
    steps.find((s) => s.status === "running")?.step ??
    steps.find((s) => s.status !== "done")?.step ??
    steps[steps.length - 1]?.step;
  if (stuck) {
    markFailed(templateId, stuck, {
      code: "PIPELINE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  setTemplateStatus(templateId, "failed");
}

function setTemplateStatus(templateId: string, status: "importing" | "cloning" | "failed"): void {
  db()
    .prepare("UPDATE templates SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), templateId);
}

/** 时长上限跟设置走（REQ-008 的 referenceMaxSeconds），不再硬编码一份 180 */
function readMaxSeconds(): number {
  const row = db().prepare("SELECT reference_max_seconds FROM settings WHERE id = 1").get() as
    { reference_max_seconds: number } | undefined;
  return row?.reference_max_seconds ?? 180;
}

interface StepContextLike extends StartArgs {
  workspace: string;
  maxSeconds: number;
}

/** 跑一步，成功返回 true。失败已经落库，调用方只需停下来。 */
async function runStep(step: EvidenceStep, ctx: StepContextLike): Promise<boolean> {
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
function classify(error: unknown): { code: string; message: string; timedOut?: boolean; raw?: string } {
  if (error instanceof HypitError) {
    // BAD_OUTPUT / TIMEOUT 这两条支路的 message 是我们自己编的，唯一的线索
    // 全在 raw 与 help 里。不带上就真成了「吞错」
    const message = error.help ? `${error.message}\n${error.help}` : error.message;
    return {
      code: error.code,
      message,
      ...(error.code === "TIMEOUT" ? { timedOut: true } : {}),
      ...(error.raw ? { raw: error.raw } : {}),
    };
  }
  if (error instanceof EvidenceError) return { code: error.code, message: error.message };
  return { code: "UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
}
