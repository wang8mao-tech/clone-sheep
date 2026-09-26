import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { sseHub } from "../lib/sse.js";
import { EVIDENCE_STEPS, type EvidenceStatus, type EvidenceStep, type StepView } from "./evidence-rules.js";

/**
 * 证据步骤的落库与推送。
 *
 * 状态必须落库而不是只放内存：REQ-002 要求刷新页面后清单还在，而且后端重启后
 * 用户得知道上次卡在哪一步。每次状态变化推一条 SSE，前端只拿它当「快照失效」
 * 的提示，真相始终在库里。
 */

export interface StepRow {
  id: string;
  template_id: string;
  step: EvidenceStep;
  status: EvidenceStatus;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  error_raw: string | null;
  detail: string | null;
}

export interface StepRecord extends StepView {
  startedAt?: string;
  endedAt?: string;
  /** 原始 stdout/stderr，界面原样展示不改写（REQ-002 MUST） */
  errorRaw?: string;
  detail?: unknown;
}

/** 建齐四步的 pending 行。已经有的不动——重跑不该把已完成的步骤抹掉。 */
export function ensureSteps(templateId: string): void {
  const d = db();
  const now = new Date().toISOString();
  const insert = d.prepare(
    `INSERT OR IGNORE INTO evidence_steps (id, template_id, step, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  );
  d.transaction(() => {
    for (const step of EVIDENCE_STEPS) insert.run(randomUUID(), templateId, step, now, now);
  })();
}

export function listSteps(templateId: string): StepRecord[] {
  const rows = db().prepare("SELECT * FROM evidence_steps WHERE template_id = ?").all(templateId) as StepRow[];
  const byStep = new Map(rows.map((r) => [r.step, r]));
  // 按 EVIDENCE_STEPS 的顺序输出，不靠数据库的返回顺序
  return EVIDENCE_STEPS.map((step) => toRecord(byStep.get(step), step));
}

function toRecord(row: StepRow | undefined, step: EvidenceStep): StepRecord {
  if (!row) return { step, status: "pending" };
  return {
    step,
    status: row.status,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    ...(row.error_raw ? { errorRaw: row.error_raw } : {}),
    ...(row.detail ? { detail: JSON.parse(row.detail) as unknown } : {}),
  };
}

export function markRunning(templateId: string, step: EvidenceStep): void {
  const now = new Date().toISOString();
  db()
    .prepare(
      `UPDATE evidence_steps
          SET status = 'running', started_at = ?, ended_at = NULL, duration_ms = NULL,
              error_code = NULL, error_message = NULL, error_raw = NULL, detail = NULL, updated_at = ?
        WHERE template_id = ? AND step = ?`,
    )
    .run(now, now, templateId, step);
  publish(templateId, step);
}

/**
 * 运行中的附注（如「正在启动 WhisperX 服务」），null 清掉。只改还在跑的那一步，并推一条 SSE。
 * 开跑时 markRunning 已经清过 detail：上一轮的附注或结果不该在重跑时冒出来（复审第三轮 M2）
 */
export function noteRunning(templateId: string, step: EvidenceStep, note: string | null): void {
  db()
    .prepare(
      `UPDATE evidence_steps SET detail = ?, updated_at = ?
        WHERE template_id = ? AND step = ? AND status = 'running'`,
    )
    .run(note === null ? null : JSON.stringify({ note }), new Date().toISOString(), templateId, step);
  publish(templateId, step);
}

export function markDone(templateId: string, step: EvidenceStep, detail?: unknown): void {
  finish(templateId, step, "done", { detail });
}

export function markFailed(
  templateId: string,
  step: EvidenceStep,
  error: { code: string; message: string; timedOut?: boolean; raw?: string },
): void {
  finish(templateId, step, error.timedOut ? "timeout" : "failed", { error });
}

function finish(
  templateId: string,
  step: EvidenceStep,
  status: EvidenceStatus,
  extra: { detail?: unknown; error?: { code: string; message: string; raw?: string } },
): void {
  const now = new Date().toISOString();
  const row = db()
    .prepare("SELECT started_at FROM evidence_steps WHERE template_id = ? AND step = ?")
    .get(templateId, step) as { started_at: string | null } | undefined;
  // 起始时间丢了就不编一个耗时出来——显示"—"比显示一个假数字好
  const durationMs = row?.started_at ? Date.now() - new Date(row.started_at).getTime() : null;

  db()
    .prepare(
      `UPDATE evidence_steps
          SET status = ?, ended_at = ?, duration_ms = ?, error_code = ?, error_message = ?,
              error_raw = ?, detail = COALESCE(?, detail), updated_at = ?
        WHERE template_id = ? AND step = ?`,
    )
    .run(
      status,
      now,
      durationMs,
      extra.error?.code ?? null,
      extra.error?.message ?? null,
      extra.error?.raw ?? null,
      extra.detail === undefined ? null : JSON.stringify(extra.detail),
      now,
      templateId,
      step,
    );
  publish(templateId, step);
}

/** 重跑前把四步清回 pending。换了源视频时用——旧的探测结果不能留着骗人。 */
export function resetSteps(templateId: string): void {
  const now = new Date().toISOString();
  db()
    .prepare(
      `UPDATE evidence_steps
          SET status = 'pending', started_at = NULL, ended_at = NULL, duration_ms = NULL,
              error_code = NULL, error_message = NULL, error_raw = NULL, detail = NULL, updated_at = ?
        WHERE template_id = ?`,
    )
    .run(now, templateId);
  publish(templateId);
}

/**
 * 推一条「这个模板的证据状态变了」。
 * 订阅的是 `template:<id>` 而不是 global：别让一个模板的进度把所有页面都刷一遍。
 */
function publish(templateId: string, step?: EvidenceStep): void {
  sseHub.publish(`template:${templateId}`, "evidence", { templateId, ...(step ? { step } : {}) });
}
