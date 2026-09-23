import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.js";
import { HypitError, runHypit } from "../hypit/cli.js";
import { resetAgentProducts } from "../hypit/workspace.js";
import { agentScheduler, failFinishedJob, notify, onJobChange } from "../agent/agent-service.js";
import { activeJobsOf, latestJobOf, requireJob, type AgentJobRow } from "../agent/job-store.js";
import { clonePrompt, cloneRetryPrompt } from "../agent/prompts.js";
import { findTemplate, requireTemplate } from "./archive.js";
import { setCloneStarter } from "./clone-starter.js";
import { saveVerdict, verdictFor, type CloneVerdict } from "./clone-verdicts.js";
import { cancelOpenReplicas, ensureReplica } from "./replicas.js";

export { latestReplica, type ReplicaRow } from "./replicas.js";

/**
 * 复刻编排（REQ-004 / FLOW-002 步骤 3-4）。
 *
 * 两件事：证据准备刚做完时自动起复刻任务；Agent 说做完了之后，宿主自己核完成判据——
 * `reference.svrun` 存在且 `hypit check --json` 通过、`ANALYSIS.md` 与 `TIMELINE.md` 存在。
 * Agent 的自述不算数：判据不过（或核的过程本身出错）就把任务改判失败并写明原因，横条随之给
 * 「继续 / 重跑」。判据通过才建复刻片（replica production），估价与出片从它接手。
 */

export const CLONE_FILES = ["reference.svrun", "ANALYSIS.md", "TIMELINE.md"] as const;

interface Log {
  error: (obj: object, msg: string) => void;
  info?: (obj: object, msg: string) => void;
}

const silent: Log = { error: () => undefined };

/**
 * 每一次「完成」只核一次：完成之后还可能有花费之类的补丁再推一次状态，按「任务 + 结束时刻」去重。
 * 不按任务 id：判据不过、人点「继续」后同一个任务会再完成一次，那一次必须重新核。
 */
const verified = new Set<string>();

/** 启动时调用一次：接上证据流水线的自动启动，订阅任务完成去核判据，并补核重启前没核完的 */
export function registerCloneFlow(log: Log = silent): () => void {
  setCloneStarter((templateId) => {
    try {
      if (!startClone(templateId)) log.info?.({ templateId }, "证据准备做完了，但模板不在复刻中或已有任务，没起新任务");
    } catch (error) {
      log.error({ templateId, error }, "证据准备做完了，但复刻任务没起来");
    }
  });
  const check = (job: AgentJobRow): void => {
    if (job.owner_kind !== "template" || job.status !== "done") return;
    const key = `${job.id}@${job.ended_at ?? ""}`;
    if (verified.has(key)) return;
    verified.add(key);
    verifyClone(job).catch((error: unknown) => log.error({ jobId: job.id, error }, "核复刻完成判据时出错"));
  };
  const unsubscribe = onJobChange(check);
  // 进程在核的那几秒里退出：任务停在「完成」却没有结论，既不能继续也不能重跑。启动时补核一次。
  // 这不是「补跑」：不起任何 Agent 任务，只核已经完成的那一次
  for (const job of unverifiedFinishedJobs()) check(job);
  return () => {
    unsubscribe();
    setCloneStarter(undefined);
    verified.clear();
  };
}

function unverifiedFinishedJobs(): AgentJobRow[] {
  const templates = db().prepare("SELECT id FROM templates WHERE status = 'cloning'").all() as Array<{ id: string }>;
  return templates
    .map((t) => latestJobOf("template", t.id))
    .filter((job): job is AgentJobRow => job?.status === "done" && !verdictFor(job.id, job.ended_at));
}

/**
 * 起复刻任务。只在模板正处于「复刻中」、且上面没有在跑的任务时起（换参考视频在有任务时会被
 * 证据流水线直接拒掉，见 evidence.ts）。起之前清掉上一轮的 Agent 产物、作废没出片的复刻片：
 * 那些是按旧参考视频写的，留着会被估价、出片当成这一轮的。返回新任务，没起就返回 undefined。
 */
export function startClone(templateId: string): AgentJobRow | undefined {
  const template = findTemplate(templateId);
  if (!template?.workspace_path || template.status !== "cloning") return undefined;
  if (activeJobsOf("template", templateId).length > 0) return undefined;
  resetAgentProducts(template.workspace_path);
  cancelOpenReplicas(templateId);
  const prompt = clonePrompt({
    language: template.language ?? "未知",
    ...(template.note ? { note: template.note } : {}),
  });
  return agentScheduler().enqueue({ ownerKind: "template", ownerId: templateId, prompt });
}

type Judgement = Omit<CloneVerdict, "jobId" | "jobEndedAt" | "createdAt">;

/** 核一次已完成复刻任务的完成判据，结论落库；通过建复刻片，不过（含核的过程出错）改判任务失败 */
export async function verifyClone(job: AgentJobRow): Promise<CloneVerdict> {
  let result: Judgement;
  try {
    result = await judge(job);
  } catch (e) {
    // 核不了也要给人一个出口：记成失败结论并改判，横条给「继续 / 重跑」，而不是只在日志里留一句
    result = { ok: false, missing: [], check: null, error: `核对完成判据时出错：${String(e)}` };
  }
  const verdict = db().transaction(() => {
    const saved = saveVerdict({ templateId: job.owner_id, jobId: job.id, jobEndedAt: job.ended_at, ...result });
    if (saved.ok && isCurrentRun(job)) ensureReplica(job.owner_id);
    return saved;
  })();
  if (!verdict.ok) failFinishedJob(job.id, failureReason(verdict), job.ended_at);
  notify(`template:${job.owner_id}`, "clone", verdict);
  return verdict;
}

async function judge(job: AgentJobRow): Promise<Judgement> {
  const template = requireTemplate(job.owner_id);
  const workspace = template.workspace_path;
  if (!workspace) throw new Error(`模板还没有工作目录：${template.id}`);
  const missing = CLONE_FILES.filter((file) => !existsSync(join(workspace, file)));
  let check: unknown = null;
  let error: string | null = null;
  if (!missing.includes("reference.svrun")) {
    try {
      // 所有 hypit 调用显式 --workspace（REQ-002 MUST）
      const out = await runHypit<{ ok?: unknown; diagnostics?: unknown }>(
        ["check", "reference.svrun", "--workspace", workspace, "--json"],
        {
          cwd: workspace,
          subject: { kind: "template", id: template.id },
        },
      );
      check = out.json;
      // hypit 0.2.6 的 check 失败走 cli-error（上面的 catch），这里是防御：万一给了 ok:false，
      // 停止原因要带上它说的第一条诊断，而不是一句空话
      if (out.json.ok !== true) error = firstDiagnostic(out.json.diagnostics) ?? "check 输出 ok 不为 true";
    } catch (e) {
      // 原文整段留给页面（报错、帮助、stderr），任务的停止原因只取第一行
      error = e instanceof HypitError ? [e.message, e.help, e.raw].filter(Boolean).join("\n") : String(e);
    }
  }
  return { ok: missing.length === 0 && error === null, missing, check, error };
}

function firstDiagnostic(diagnostics: unknown): string | undefined {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return undefined;
  const first: unknown = diagnostics[0];
  return typeof first === "string" ? first : JSON.stringify(first);
}

/**
 * 核的过程中情况可能变了：人换了参考视频（模板回到导入中）或起了新一轮。只有模板仍在「复刻中」、
 * 任务仍是最新、仍是完成、仍是同一次完成的，才建复刻片
 */
function isCurrentRun(job: AgentJobRow): boolean {
  const now = requireJob(job.id);
  const latest = latestJobOf(job.owner_kind, job.owner_id);
  const template = findTemplate(job.owner_id);
  return (
    template?.status === "cloning" && latest?.id === job.id && now.status === "done" && now.ended_at === job.ended_at
  );
}

function failureReason(verdict: CloneVerdict): string {
  const parts: string[] = [];
  if (verdict.missing.length) parts.push(`缺少 ${verdict.missing.join("、")}`);
  if (verdict.error) {
    const first = verdict.error.split("\n")[0] ?? "";
    parts.push(first.startsWith("核对完成判据时出错") ? first : `hypit check 未通过：${first}`);
  }
  return `复刻未达完成判据：${parts.join("；")}`;
}

/**
 * 判据没过之后点「继续」：把没过的原因作为这一轮的话交给会话（审查 S2-M3）。
 * 不是这种情况、或会话没起来（没有可 resume 的上下文）时返回 undefined，走通用的继续。
 */
export function continuePromptFor(jobId: string): string | undefined {
  const job = requireJob(jobId);
  if (job.owner_kind !== "template" || !job.session_id) return undefined;
  const verdict = verdictFor(job.id, job.ended_at);
  if (!verdict || verdict.ok || !job.stop_reason) return undefined;
  return cloneRetryPrompt(job.stop_reason);
}

/** ② 复刻页看的结论：只给和当前这次运行对得上的那条；任务完成了还没有结论就是「核对中」 */
export function currentVerdict(templateId: string): { verdict: CloneVerdict | null; verifying: boolean } {
  const job = latestJobOf("template", templateId);
  if (!job?.ended_at) return { verdict: null, verifying: false };
  const verdict = verdictFor(job.id, job.ended_at) ?? null;
  return { verdict, verifying: job.status === "done" && verdict === null };
}
