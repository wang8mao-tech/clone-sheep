import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { jobProfile, type CostBasis } from "./profile-env.js";

/**
 * agent_jobs 的读写（Spec REQ-003 状态：排队 / 运行中 / 等待额度 / 已熔断 / 中断 / 完成 / 已取消，
 * 外加进程或 SDK 自身出错的「失败」）。调度器之外不直接改这张表。
 */

export type JobStatus =
  "queued" | "running" | "awaiting_quota" | "tripped" | "interrupted" | "done" | "failed" | "cancelled";

export type OwnerKind = "template" | "production";

export interface AgentJobRow {
  id: string;
  owner_kind: OwnerKind;
  owner_id: string;
  session_id: string | null;
  status: JobStatus;
  started_at: string | null;
  ended_at: string | null;
  cost_usd: number;
  cost_is_estimate: number;
  stop_reason: string | null;
  profile_id: string | null;
  profile_name: string | null;
  model_id: string | null;
  cost_basis: CostBasis | null;
  prompt: string | null;
  resume_at: string | null;
  /** 本次运行**这一段**的起点（只在运行中有意义）；started_at 是任务第一次开始的时间 */
  run_started_at: string | null;
  /** 本次运行在此之前已经跑掉的毫秒数（等额度、排队都不算），见 AgentJobView.runElapsedMs */
  run_elapsed_ms: number;
  created_at: string;
  updated_at: string | null;
}

/** 还没结束的状态：删对象前要先停掉它们，同一对象也不许再开第二个 */
export const ACTIVE_STATUSES: readonly JobStatus[] = ["queued", "running", "awaiting_quota"];
/** 能「继续」的状态：会话还在，resume 它 */
export const CONTINUABLE_STATUSES: readonly JobStatus[] = ["tripped", "interrupted", "failed"];
/** 能「重跑」的状态：熔断、中断、失败之后，以及取消了的。完成的不许——那会清掉一份可能已验货通过的稿子 */
export const RERUNNABLE_STATUSES: readonly JobStatus[] = ["tripped", "interrupted", "failed", "cancelled"];

export interface NewJob {
  ownerKind: OwnerKind;
  ownerId: string;
  prompt: string;
  /** 用哪个模型档案（REQ-010）；不给用默认档案 */
  profileId?: string | undefined;
  /** Phase 8 的过渡做法：内置订阅 + 指定模型 id（老任务重跑、④ 老接口） */
  modelId?: string | undefined;
}

/** 建任务时记下档案快照（名称与模型 id 不随档案删改而变，AC-030）；档案不能用就抛，不建任务 */
export function createJob(input: NewJob): AgentJobRow {
  const snapshot = jobProfile({
    ownerKind: input.ownerKind,
    profileId: input.profileId,
    legacyModelId: input.modelId ?? null,
  });
  const now = new Date().toISOString();
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, prompt, profile_id, profile_name, model_id, cost_basis,
         created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.ownerKind,
      input.ownerId,
      input.prompt,
      snapshot.profile_id,
      snapshot.profile_name,
      snapshot.model_id,
      snapshot.cost_basis,
      now,
      now,
    );
  return requireJob(id);
}

export function findJob(id: string): AgentJobRow | undefined {
  return db().prepare("SELECT * FROM agent_jobs WHERE id = ?").get(id) as AgentJobRow | undefined;
}

/** 任务不存在。单独一个类型：接口层靠它给 404，不靠匹配中文文案 */
export class JobNotFoundError extends Error {
  readonly code = "JOB_NOT_FOUND";
  readonly status = 404;

  constructor(id: string) {
    super(`Agent 任务不存在：${id}`);
    this.name = "JobNotFoundError";
  }
}

export function requireJob(id: string): AgentJobRow {
  const job = findJob(id);
  if (!job) throw new JobNotFoundError(id);
  return job;
}

export function activeJobsOf(ownerKind: OwnerKind, ownerId: string): AgentJobRow[] {
  const marks = ACTIVE_STATUSES.map(() => "?").join(", ");
  return db()
    .prepare(`SELECT * FROM agent_jobs WHERE owner_kind = ? AND owner_id = ? AND status IN (${marks})`)
    .all(ownerKind, ownerId, ...ACTIVE_STATUSES) as AgentJobRow[];
}

/** 出片单位上起 Agent 任务之前要看的两样：是否已作废、是否已交给出片流水线（有运行文件路径） */
export function productionAgentGate(id: string): { status: string; run_path: string | null } | undefined {
  return db().prepare("SELECT status, run_path FROM productions WHERE id = ?").get(id) as
    { status: string; run_path: string | null } | undefined;
}

/**
 * 模板下各条变体上还没结束的任务（Task 5.2 复审 S2-L7）。模板的继续 / 重跑 / 打回会改写或清掉
 * reference.* 与证据，而变体会话正读着它们（原稿是复制过去的，但会话可能回头去读模板目录）：
 * 模板这边要把它们也算进「未结束任务」
 */
export function activeVariantJobsOf(templateId: string): AgentJobRow[] {
  const marks = ACTIVE_STATUSES.map(() => "?").join(", ");
  return db()
    .prepare(
      `SELECT j.* FROM agent_jobs j JOIN productions p ON p.id = j.owner_id
        WHERE j.owner_kind = 'production' AND p.template_id = ? AND j.status IN (${marks})`,
    )
    .all(templateId, ...ACTIVE_STATUSES) as AgentJobRow[];
}

/**
 * 对象最新的一个任务。继续 / 重跑只许对它做：重跑开了新任务之后，旧任务的会话对应的
 * 产物已经被清掉，再 resume 它只会在别人的目录里接着写一份过时的稿子。
 * created_at 精度到毫秒可能撞车，用 rowid 兜底定先后。
 */
export function latestJobOf(ownerKind: OwnerKind, ownerId: string): AgentJobRow | undefined {
  return db()
    .prepare(
      `SELECT * FROM agent_jobs WHERE owner_kind = ? AND owner_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ownerKind, ownerId) as AgentJobRow | undefined;
}

type Patch = Partial<
  Pick<
    AgentJobRow,
    | "status"
    | "session_id"
    | "started_at"
    | "run_started_at"
    | "run_elapsed_ms"
    | "ended_at"
    | "cost_usd"
    | "stop_reason"
    | "resume_at"
    | "cost_basis"
  >
>;

const PATCHABLE = new Set<keyof Patch>([
  "status",
  "session_id",
  "started_at",
  "run_started_at",
  "run_elapsed_ms",
  "ended_at",
  "cost_usd",
  "stop_reason",
  "resume_at",
  "cost_basis",
]);

/** 只改给出的字段，顺带刷新 updated_at；列名来自白名单，值走参数 */
export function updateJob(id: string, patch: Patch): AgentJobRow {
  const entries = Object.entries(patch).filter(([k]) => PATCHABLE.has(k as keyof Patch));
  const sets = [...entries.map(([k]) => `${k} = ?`), "updated_at = ?"].join(", ");
  db()
    .prepare(`UPDATE agent_jobs SET ${sets} WHERE id = ?`)
    .run(...entries.map(([, v]) => v ?? null), new Date().toISOString(), id);
  return requireJob(id);
}
