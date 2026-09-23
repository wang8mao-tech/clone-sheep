import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../config.js";
import { db, schemaPath } from "./index.js";

/**
 * 迁移机制：schema.sql 是全量定义，全部语句写成幂等形式（IF NOT EXISTS），
 * 每次启动执行一遍即可把库拉到最新。schema_migrations 记录已应用的版本号，
 * 将来需要改列（SQLite 改列要重建表）时在 STEPS 里追加一步。
 */
const STEPS: ReadonlyArray<{ version: number; run: (d: ReturnType<typeof db>) => void }> = [
  {
    // 已存在的库补上凭据验证时间列。schema.sql 的 CREATE TABLE IF NOT EXISTS
    // 不会给老表加列，加列只能走 ALTER。
    version: 1,
    run: (d) => {
      const columns = d.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>;
      const have = new Set(columns.map((c) => c.name));
      if (!have.has("tokendance_verified_at")) d.exec("ALTER TABLE settings ADD COLUMN tokendance_verified_at TEXT");
      if (!have.has("hypihub_verified_at")) d.exec("ALTER TABLE settings ADD COLUMN hypihub_verified_at TEXT");
    },
  },
  {
    // evidence_steps 在 Task 4.2 先建了表，审查后才加 error_raw。老库里那张表
    // 已经存在，schema.sql 的 CREATE TABLE IF NOT EXISTS 不会给它加列。
    version: 2,
    run: (d) => {
      const columns = d.prepare("PRAGMA table_info(evidence_steps)").all() as Array<{ name: string }>;
      const have = new Set(columns.map((c) => c.name));
      if (columns.length > 0 && !have.has("error_raw")) {
        d.exec("ALTER TABLE evidence_steps ADD COLUMN error_raw TEXT");
      }
    },
  },
  {
    // Task 5.2 调度器：重跑要任务提示原文，等待额度要记续跑时间。agent_jobs 在 Phase 1 就建了
    version: 3,
    run: (d) => addAgentJobColumns(d, ["prompt", "resume_at", "updated_at"]),
  },
  {
    /**
     * Task 5.3 抽屉要「本次运行的起点」。**必须是新的一步**：version 3 在 Task 5.2 就记进
     * schema_migrations 了，往它的列清单里加一列，对所有已经跑过 3 的库都是空操作——
     * 新库因为 schema.sql 里有这列而看不出问题，老库则是每次开跑都 no such column。
     * 加列只能加新版本号，这条是本项目第二次踩（第一次是 evidence_steps.error_raw）。
     */
    version: 4,
    run: (d) => addAgentJobColumns(d, ["run_started_at"]),
  },
  {
    // Task 5.3 复审：单个时间戳表达不了「等额度期间用时冻住」，改成累计毫秒数
    version: 5,
    run: (d) => {
      const have = new Set(
        (d.prepare("PRAGMA table_info(agent_jobs)").all() as Array<{ name: string }>).map((c) => c.name),
      );
      if (!have.has("run_elapsed_ms")) {
        d.exec("ALTER TABLE agent_jobs ADD COLUMN run_elapsed_ms INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    // Task 6.1 复审：结论要绑到任务的哪一次完成上。表是同一个 Task 里建的，但 6.1 首版可能已经
    // 在用户机器上跑过（start.bat 直接用工作区代码），老表没有这一列
    version: 6,
    run: (d) => {
      const columns = d.prepare("PRAGMA table_info(clone_verdicts)").all() as Array<{ name: string }>;
      if (columns.length > 0 && !columns.some((c) => c.name === "job_ended_at")) {
        d.exec("ALTER TABLE clone_verdicts ADD COLUMN job_ended_at TEXT");
      }
      d.exec("CREATE INDEX IF NOT EXISTS idx_clone_verdicts_job ON clone_verdicts (job_id, job_ended_at)");
    },
  },
];

/** agent_jobs 补列：老库里那张表已经存在，schema.sql 的 CREATE TABLE IF NOT EXISTS 不会给它加列 */
function addAgentJobColumns(d: ReturnType<typeof db>, columns: readonly string[]): void {
  const have = new Set(
    (d.prepare("PRAGMA table_info(agent_jobs)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const column of columns) {
    if (!have.has(column)) d.exec(`ALTER TABLE agent_jobs ADD COLUMN ${column} TEXT`);
  }
}

export function migrate(): void {
  const d = db();
  d.exec(readFileSync(schemaPath(), "utf8"));

  const applied = new Set(
    d
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((r) => (r as { version: number }).version),
  );
  const record = d.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  for (const step of STEPS) {
    if (applied.has(step.version)) continue;
    d.transaction(() => {
      step.run(d);
      record.run(step.version, new Date().toISOString());
    })();
  }

  seedSettings(d);
}

/** settings 是单例行，不存在就按 Spec REQ-008 的默认值建一行。 */
function seedSettings(d: ReturnType<typeof db>): void {
  const exists = d.prepare("SELECT 1 FROM settings WHERE id = 1").get();
  if (exists) return;
  d.prepare("INSERT INTO settings (id, updated_at) VALUES (1, ?)").run(new Date().toISOString());
}

/**
 * 进程被杀后重启，库里会留下永远不会再动的"运行中"记录。
 * 启动时统一标为"中断"，前端据此给"继续"按钮（Spec AC-010）。
 */
export function markStaleRunningAsInterrupted(): {
  jobs: number;
  productions: number;
  builds: number;
  evidence: number;
} {
  const d = db();
  const now = new Date().toISOString();
  const jobs = d
    .prepare(
      `UPDATE agent_jobs SET status = 'interrupted', ended_at = COALESCE(ended_at, ?),
         stop_reason = COALESCE(stop_reason, 'backend_restart'),
         -- 续跑的定时器随进程没了，留着这个时间界面会显示「将在 … 自动续跑」，但永远不会到
         resume_at = NULL, updated_at = ?
       WHERE status IN ('running', 'queued', 'awaiting_quota')`,
    )
    .run(now, now).changes;
  const productions = d
    .prepare(
      `UPDATE productions SET status = 'interrupted', updated_at = ?
       WHERE status IN ('agent_running', 'awaiting_quota', 'building')`,
    )
    .run(now).changes;
  // evidence_steps 的 CHECK 里没有 interrupted，且失败通道本来就能重试，
  // 所以照 builds 的做法标 failed + 一个能看懂的原因。不标的话，后端一重启，
  // 库里那行 running 会永远转圈，而重试又只放行 failed/timeout——用户被卡死，
  // 唯一出路是重新提交视频，界面上却没有任何东西这么告诉他
  // 模板状态跟着改回 failed，必须在改步骤之前做（之后就认不出哪些模板刚才在跑）。
  // 不改的话模板停在 importing，步骤条和侧栏都说「进行中」，清单里却已经是失败待重试
  // （Task 4.4 复审第三轮实测）
  d.prepare(
    `UPDATE templates SET status = 'failed', updated_at = ?
      WHERE status = 'importing'
        AND id IN (SELECT template_id FROM evidence_steps WHERE status = 'running')`,
  ).run(now);
  const evidence = d
    .prepare(
      `UPDATE evidence_steps SET status = 'failed', ended_at = COALESCE(ended_at, ?),
         error_code = COALESCE(error_code, 'BACKEND_RESTART'),
         error_message = COALESCE(error_message, '后端进程重启，这一步的结果未知，可以重试')
       WHERE status = 'running'`,
    )
    .run(now).changes;

  const builds = d
    .prepare(
      `UPDATE builds SET status = 'failed', ended_at = COALESCE(ended_at, ?),
         error_code = COALESCE(error_code, 'BACKEND_RESTART'),
         error_message = COALESCE(error_message, '后端进程重启，该次出片状态未知')
       WHERE status IN ('queued', 'running')`,
    )
    .run(now).changes;
  return { jobs, productions, builds, evidence };
}

// 允许 `pnpm db:migrate` 直接跑：比较本模块路径与进程入口路径
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate();
  console.log(`migrate: done -> ${paths.db}`);
}
