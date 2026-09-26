import { db } from "../db/index.js";

/**
 * clone_verdicts 的读写：每一次复刻任务「完成」后宿主核完成判据的结论（REQ-004）。
 *
 * 一条结论绑在「哪个任务的哪一次完成」上（job_id + job_ended_at）：判据没过、人点「继续」后
 * 同一个任务会再完成一次，那一次要有自己的结论，页面也只该信和当前这次运行对得上的那条。
 */

export interface CloneVerdict {
  jobId: string;
  /** 核的是这个任务哪一次完成（agent_jobs.ended_at 的快照） */
  jobEndedAt: string | null;
  ok: boolean;
  /** 缺的文件，按 CLONE_FILES 的顺序 */
  missing: string[];
  /** `hypit check --json` 的原样输出；reference.svrun 缺了就没跑 */
  check: unknown;
  /** check 跑不起来、没通过，或核的过程本身出错时的原文 */
  error: string | null;
  createdAt: string;
}

interface VerdictRow {
  job_id: string;
  job_ended_at: string | null;
  ok: number;
  missing_json: string;
  check_json: string | null;
  error_text: string | null;
  created_at: string;
}

export interface VerdictInput {
  templateId: string;
  jobId: string;
  jobEndedAt: string | null;
  ok: boolean;
  missing: string[];
  check: unknown;
  error: string | null;
}

export function saveVerdict(input: VerdictInput): CloneVerdict {
  const createdAt = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO clone_verdicts
         (template_id, job_id, job_ended_at, ok, missing_json, check_json, error_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.templateId,
      input.jobId,
      input.jobEndedAt,
      input.ok ? 1 : 0,
      JSON.stringify(input.missing),
      input.check === null || input.check === undefined ? null : JSON.stringify(input.check),
      input.error,
      createdAt,
    );
  const { templateId: _templateId, ...rest } = input;
  return { ...rest, createdAt };
}

/** 某个任务某一次完成的结论；没核过（或还在核）返回 undefined */
export function verdictFor(jobId: string, jobEndedAt: string | null): CloneVerdict | undefined {
  const row = db()
    .prepare("SELECT * FROM clone_verdicts WHERE job_id = ? AND job_ended_at IS ? ORDER BY id DESC LIMIT 1")
    .get(jobId, jobEndedAt) as VerdictRow | undefined;
  return row ? fromRow(row) : undefined;
}

function fromRow(row: VerdictRow): CloneVerdict {
  return {
    jobId: row.job_id,
    jobEndedAt: row.job_ended_at,
    ok: row.ok === 1,
    missing: JSON.parse(row.missing_json) as string[],
    check: row.check_json === null ? null : (JSON.parse(row.check_json) as unknown),
    error: row.error_text,
    createdAt: row.created_at,
  };
}
