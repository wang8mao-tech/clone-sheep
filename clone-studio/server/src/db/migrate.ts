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
];

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
export function markStaleRunningAsInterrupted(): { jobs: number; productions: number; builds: number } {
  const d = db();
  const now = new Date().toISOString();
  const jobs = d
    .prepare(
      `UPDATE agent_jobs SET status = 'interrupted', ended_at = COALESCE(ended_at, ?),
         stop_reason = COALESCE(stop_reason, 'backend_restart')
       WHERE status IN ('running', 'queued', 'awaiting_quota')`,
    )
    .run(now).changes;
  const productions = d
    .prepare(
      `UPDATE productions SET status = 'interrupted', updated_at = ?
       WHERE status IN ('agent_running', 'awaiting_quota', 'building')`,
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
  return { jobs, productions, builds };
}

// 允许 `pnpm db:migrate` 直接跑：比较本模块路径与进程入口路径
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate();
  console.log(`migrate: done -> ${paths.db}`);
}
