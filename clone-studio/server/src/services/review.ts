import { db } from "../db/index.js";
import { agentScheduler, notify } from "../agent/agent-service.js";
import { activeJobsOf, latestJobOf, type AgentJobRow } from "../agent/job-store.js";
import { appendReworkPending, REWORK_PENDING_TYPE } from "../agent/message-store.js";
import { rejectPrompt } from "../agent/prompts.js";
import { ArchiveError, requireTemplate, type TemplateStatus } from "./archive.js";
import { latestBuildRow } from "./build-store.js";
import { latestReplica } from "./replicas.js";

/**
 * ③ 验货（REQ-004 后半、FLOW-002 步骤 6-7）：看这一轮的历次复刻片版本、通过、打回。
 *
 * 「这一轮」= 当前复刻任务建起来之后的版本：打回是 resume 同一个任务，v1、v2 … 都在这一轮里；
 * 换参考视频或重跑会起新任务，之前的版本是按旧稿子 / 旧参考视频出的，不再拿来对比。
 * 只准通过最新一版已出片的复刻片——④ 变体要从工作目录里当前的 reference.svrun 出发，那正是最新一版的稿子。
 */

export const REWORK_NOTE_MAX = 2000;

export interface ReviewVersion {
  id: string;
  version: number;
  /** 出片单位的状态：queued / awaiting_cost_confirm / building / done / failed / interrupted */
  status: string;
  createdAt: string;
  /** 出过片才有：最新一次 build 的结果（出片卡 CMP-007 另外按出片单位拉全量） */
  build: { id: string; status: string; errorCode: string | null; endedAt: string | null } | null;
  /** 已出片的播放地址（复刻片 mp4，走 range）；没出片是 null */
  videoUrl: string | null;
}

export interface ReviewState {
  templateId: string;
  templateStatus: TemplateStatus;
  approvedReplicaId: string | null;
  /** 版本升序；最后一项是最新一版 */
  versions: ReviewVersion[];
  /** 最新一版已出片且模板在等验货：「通过验货」可用 */
  approvable: boolean;
  /** 模板在等验货、最新一版已出片、复刻任务完成且会话还在：「打回」可用 */
  reworkable: boolean;
  /** 下一次打回是第几轮（第一次复刻是第 1 轮），抽屉的「打回意见 #n」与提示词用它 */
  nextRound: number;
}

export function reviewState(templateId: string): ReviewState {
  const template = requireTemplate(templateId);
  const job = latestJobOf("template", templateId);
  const versions = roundReplicas(templateId, job).map(presentVersion);
  const latest = versions.at(-1);
  const reviewing = template.status === "awaiting_review" && latest?.status === "done";
  return {
    templateId,
    templateStatus: template.status,
    approvedReplicaId: template.approved_replica_id,
    versions,
    approvable: reviewing,
    reworkable: reviewing && job?.status === "done" && Boolean(job.session_id),
    nextRound: job ? reworkCount(job.id) + 2 : 2,
  };
}

/** 通过验货：模板置「已验货」、记下是哪一版（它作为第一条成片入库），④ 变体与 ⑤ 成片随之解锁 */
export function approveReplica(templateId: string, productionId: string): ReviewState {
  const template = requireTemplate(templateId);
  if (template.status !== "awaiting_review") {
    throw new ArchiveError("这个模板现在不在等验货", "NOT_REVIEWING", 409);
  }
  const latest = latestReplica(templateId);
  if (!latest || latest.id !== productionId || latest.status !== "done") {
    throw new ArchiveError("只能通过最新一版已出片的复刻片", "NOT_LATEST", 409);
  }
  if (activeJobsOf("template", templateId).length > 0) {
    throw new ArchiveError("复刻任务还在跑，等它结束再验货", "AGENT_ACTIVE", 409);
  }
  const now = new Date().toISOString();
  const changed = db()
    .prepare(
      `UPDATE templates SET status = 'approved', approved_replica_id = ?, updated_at = ?
        WHERE id = ? AND status = 'awaiting_review'`,
    )
    .run(productionId, now, templateId).changes;
  if (changed === 0) throw new ArchiveError("这个模板现在不在等验货", "NOT_REVIEWING", 409);
  announce(templateId);
  return reviewState(templateId);
}

/**
 * 打回：意见（1-2000 字）作为新一轮 resume 进原复刻会话，模板回到「复刻中」。之后照 ② 的路子走：
 * 会话完成 → 宿主核判据 → 估价过闸门 → 出下一版复刻片 → 模板回到「等验货」。旧版本都留着供对比。
 */
export function reworkReplica(templateId: string, note: string): AgentJobRow {
  const text = note.trim();
  if (text.length === 0 || text.length > REWORK_NOTE_MAX) {
    throw new ArchiveError(`打回意见要 1-${REWORK_NOTE_MAX} 字`, "INVALID_NOTE", 400);
  }
  const state = reviewState(templateId);
  if (state.templateStatus !== "awaiting_review") {
    throw new ArchiveError("这个模板现在不在等验货", "NOT_REVIEWING", 409);
  }
  if (!state.reworkable) {
    throw new ArchiveError("最新一版还没出片，或复刻会话已经接不上，不能打回", "NOT_REWORKABLE", 409);
  }
  const job = latestJobOf("template", templateId) as AgentJobRow;
  const prompt = rejectPrompt(text, state.nextRound);
  const next = agentScheduler().rework(job.id, prompt);
  // 排队那一刻就把意见落库：还没开跑就被中止 / 后端重启，「继续」照样交给会话（S2-M1）
  appendReworkPending(job.id, prompt);
  // 回到「复刻中」：核判据只在这个状态下建下一版复刻片（clone.ts isCurrentRun）
  db()
    .prepare("UPDATE templates SET status = 'cloning', updated_at = ? WHERE id = ? AND status = 'awaiting_review'")
    .run(new Date().toISOString(), templateId);
  announce(templateId);
  return next;
}

function roundReplicas(templateId: string, job: AgentJobRow | undefined) {
  return db()
    .prepare(
      `SELECT id, version, status, created_at FROM productions
        WHERE template_id = ? AND kind = 'replica' AND status <> 'cancelled' AND created_at >= ?
        ORDER BY version`,
    )
    .all(templateId, job?.created_at ?? "") as Array<{
    id: string;
    version: number;
    status: string;
    created_at: string;
  }>;
}

function presentVersion(row: { id: string; version: number; status: string; created_at: string }): ReviewVersion {
  const build = latestBuildRow(row.id);
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    createdAt: row.created_at,
    build: build ? { id: build.id, status: build.status, errorCode: build.error_code, endedAt: build.ended_at } : null,
    videoUrl: row.status === "done" && build?.output_path ? `/api/productions/${row.id}/video` : null,
  };
}

/**
 * 打回意见排上了队、却还没以 rework 一轮交给过会话（排队中被中止、后端在开跑前重启）：返回那句话，「继续」用它、
 * 运行类型记成 rework。一轮开跑时宿主会记一条同文的 rework 提示，看到它就说明已经交出去了
 */
export function pendingRework(jobId: string): string | undefined {
  const rows = db()
    .prepare(
      `SELECT seq, type, json_extract(payload, '$.kind') AS kind, json_extract(payload, '$.text') AS text
         FROM agent_messages WHERE job_id = ? AND type IN (?, 'host_prompt') ORDER BY seq`,
    )
    .all(jobId, REWORK_PENDING_TYPE) as Array<{ seq: number; type: string; kind: string | null; text: string | null }>;
  const last = rows.filter((r) => r.type === REWORK_PENDING_TYPE).at(-1);
  if (!last?.text) return undefined;
  // 交出去了：有同文的 rework 提示（开跑时它可能落在这笔之前），或者这笔之后又有任何一轮交给了会话（人另写了话继续）
  const delivered = rows.some(
    (r) => r.type === "host_prompt" && ((r.kind === "rework" && r.text === last.text) || r.seq > last.seq),
  );
  return delivered ? undefined : last.text;
}

/** 这个任务已经被打回过几次（宿主记下的 rework 提示条数） */
function reworkCount(jobId: string): number {
  return (
    db()
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_messages
          WHERE job_id = ? AND type = 'host_prompt' AND json_extract(payload, '$.kind') = 'rework'`,
      )
      .get(jobId) as { n: number }
  ).n;
}

function announce(templateId: string): void {
  notify("global", "archive", { kind: "template", action: "status", id: templateId });
  notify(`template:${templateId}`, "review", { templateId });
}
