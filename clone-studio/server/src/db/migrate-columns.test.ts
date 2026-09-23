import { describe, expect, it } from "vitest";
import { columnsOf, freshModules } from "./migrate-test-kit.js";

/** 加列迁移：老库的升级路径。新库由 schema.sql 直接建好，只有从「老表 + 已应用到某个版本」起跑才测得到（Task 5.3 复审 S1-H1） */

describe("加列迁移", () => {
  /**
   * 这条钉的是一个真出过的事故：Task 4.2 先建了 evidence_steps，审查后才加
   * error_raw 列。单测每次建新库所以永远碰不到，而用户的老库里那张表已经存在，
   * schema.sql 的 CREATE TABLE IF NOT EXISTS 不会给它加列——一跑流水线就
   * 「no such column: error_raw」。加列只能走 ALTER。
   */
  it("老库里已有的 evidence_steps 会被补上 error_raw", async () => {
    const { db, migrate } = await freshModules();
    const d = db();
    // 先把库拉到最新，再退回去造老表——否则 schema_migrations 都还不存在
    migrate();

    // 造一张 4.2 当时的老表：没有 error_raw
    d.exec("DROP TABLE IF EXISTS evidence_steps");
    d.exec(`CREATE TABLE evidence_steps (
      id TEXT PRIMARY KEY, template_id TEXT NOT NULL, step TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT, ended_at TEXT, duration_ms INTEGER,
      error_code TEXT, error_message TEXT, detail TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    d.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    expect(columnsOf(d, "evidence_steps")).not.toContain("error_raw");

    migrate();
    expect(columnsOf(d, "evidence_steps")).toContain("error_raw");
  });

  it("老库里的 agent_jobs 补上 prompt / resume_at / updated_at，已有记录原样保留（Task 5.2）", async () => {
    const { db, migrate } = await freshModules();
    const d = db();
    migrate();

    // Phase 1 当时的 agent_jobs：没有这三列，且已经有一条历史任务
    d.exec("DROP TABLE agent_messages");
    d.exec("DROP TABLE agent_jobs");
    d.exec(`CREATE TABLE agent_jobs (
      id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, session_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued', started_at TEXT, ended_at TEXT,
      cost_usd REAL NOT NULL DEFAULT 0, cost_is_estimate INTEGER NOT NULL DEFAULT 1,
      stop_reason TEXT, profile_name TEXT, model_id TEXT, created_at TEXT NOT NULL)`);
    d.prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, cost_usd, created_at)
       VALUES ('old', 'template', 't1', 'done', 0.42, '2026-09-01T00:00:00.000Z')`,
    ).run();
    d.prepare("DELETE FROM schema_migrations WHERE version = 3").run();

    migrate();
    expect(columnsOf(d, "agent_jobs")).toEqual(expect.arrayContaining(["prompt", "resume_at", "updated_at"]));
    expect(d.prepare("SELECT status, cost_usd, prompt FROM agent_jobs WHERE id = 'old'").get()).toEqual({
      status: "done",
      cost_usd: 0.42,
      prompt: null,
    });
  });

  /**
   * 这条钉的是 Task 5.3 复审抓到的 HIGH：run_started_at 被加进了 version 3 的列清单，
   * 而 version 3 在 Task 5.2 就记进用户的库了——于是所有老库永远不会补上这列，
   * 每次开跑都 no such column，而新库因为 schema.sql 有这列，测试全绿看不出来。
   * 从「老库 + 已应用到 3」这个前提跑迁移，才测得到升级路径。
   */
  it("已经应用到 version 3 的老库：补得上 run_started_at（Task 5.3 复审 S1-H1）", async () => {
    const { db, migrate } = await freshModules();
    const d = db();
    migrate();

    // 造一张 Task 5.2 当时的表：有 prompt / resume_at / updated_at，没有 run_started_at
    d.exec("DROP TABLE agent_messages");
    d.exec("DROP TABLE agent_jobs");
    d.exec(`CREATE TABLE agent_jobs (
      id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, session_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued', started_at TEXT, ended_at TEXT,
      cost_usd REAL NOT NULL DEFAULT 0, cost_is_estimate INTEGER NOT NULL DEFAULT 1,
      stop_reason TEXT, profile_name TEXT, model_id TEXT, prompt TEXT, resume_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT)`);
    d.prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, created_at)
       VALUES ('old', 'template', 't1', 'interrupted', '2026-09-01T00:00:00.000Z')`,
    ).run();
    d.prepare("DELETE FROM schema_migrations WHERE version > 3").run();
    expect(columnsOf(d, "agent_jobs")).not.toContain("run_started_at");
    expect(columnsOf(d, "agent_jobs")).not.toContain("run_elapsed_ms");

    migrate();
    expect(columnsOf(d, "agent_jobs")).toContain("run_started_at");
    // version 5 的累计用时也得补上，否则老库每次写库都 no such column（同一个 HIGH 的形状）
    expect(columnsOf(d, "agent_jobs")).toContain("run_elapsed_ms");
    // 补列不该动已有数据；新列对老行取默认值 0，不是 NULL——界面拿它直接加，不用防空
    expect(d.prepare("SELECT status, run_elapsed_ms FROM agent_jobs WHERE id = 'old'").get()).toEqual({
      status: "interrupted",
      run_elapsed_ms: 0,
    });
    // 补完就能按它开跑
    expect(() =>
      d
        .prepare("UPDATE agent_jobs SET run_started_at = ?, run_elapsed_ms = 1000 WHERE id = 'old'")
        .run(new Date().toISOString()),
    ).not.toThrow();
  });

  it("跑第二遍不会重复加列", async () => {
    const { db, migrate } = await freshModules();
    migrate();
    expect(() => migrate()).not.toThrow();
    expect(columnsOf(db(), "evidence_steps")).toContain("error_raw");
  });
});
