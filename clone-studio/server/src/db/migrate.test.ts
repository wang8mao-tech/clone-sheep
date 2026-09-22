import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 迁移与启动清理是有副作用的模块（会按 config 建目录、开库），
 * 所以每个用例都换一个临时数据根目录，再动态 import 让模块重新初始化。
 */
let dataRoot: string;
let closeCurrent: (() => void) | undefined;

async function freshModules() {
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  // 带 query 的动态 import 在 Vite 下不成立（Unknown variable dynamic import），
  // 用 resetModules 清模块注册表，再静态说明符重新求值。
  vi.resetModules();
  const dbMod = await import("./index.js");
  const migrateMod = await import("./migrate.js");
  closeCurrent = dbMod.closeDb;
  return { ...dbMod, ...migrateMod };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-test-"));
});

afterEach(() => {
  // 先关库再删目录：SQLite 在 Windows 上持有文件句柄，不关会 EPERM
  closeCurrent?.();
  closeCurrent = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("migrate", () => {
  it("建出 DEV-PLAN 列的全部表，并且可重复执行", async () => {
    const m = await freshModules();
    m.migrate();
    m.migrate(); // 幂等：再跑一遍不该炸

    const tables = m
      .db()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => (r as { name: string }).name);

    for (const expected of [
      "settings",
      "clients",
      "templates",
      "batches",
      "productions",
      "agent_jobs",
      "agent_messages",
      "builds",
      "assets",
      "hypit_calls",
      "model_profiles",
      "video_channels",
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it("settings 只有一行，重复迁移不会插第二行", async () => {
    const m = await freshModules();
    m.migrate();
    m.migrate();
    const count = m.db().prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("启动时把遗留的运行中记录标成中断", async () => {
    const m = await freshModules();
    m.migrate();
    const d = m.db();
    const now = new Date().toISOString();

    d.prepare("INSERT INTO clients (id, name, created_at) VALUES ('c1', 'C', ?)").run(now);
    d.prepare(
      `INSERT INTO templates (id, client_id, name, status, created_at, updated_at)
       VALUES ('t1', 'c1', 'T', 'cloning', ?, ?)`,
    ).run(now, now);
    d.prepare(
      `INSERT INTO productions (id, template_id, kind, status, created_at, updated_at)
       VALUES ('p1', 't1', 'variant', 'agent_running', ?, ?)`,
    ).run(now, now);
    d.prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, resume_at, created_at)
       VALUES ('j1', 'production', 'p1', 'awaiting_quota', '2026-09-23T10:00:00.000Z', ?)`,
    ).run(now);
    d.prepare(`INSERT INTO builds (id, production_id, status, created_at) VALUES ('b1', 'p1', 'running', ?)`).run(now);
    // 已完成的不该被动
    d.prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, created_at)
       VALUES ('j2', 'production', 'p1', 'done', ?)`,
    ).run(now);

    const changed = m.markStaleRunningAsInterrupted();
    expect(changed).toEqual({ jobs: 1, productions: 1, builds: 1, evidence: 0 });

    expect(
      d.prepare("SELECT status, stop_reason, resume_at FROM agent_jobs WHERE id='j1'").get() as never,
    ).toMatchObject({
      status: "interrupted",
      stop_reason: "backend_restart",
      // 续跑的定时器随进程没了，留着时间界面会说「将自动续跑」，但永远不会到
      resume_at: null,
    });
    expect(d.prepare("SELECT status FROM agent_jobs WHERE id='j2'").get() as never).toMatchObject({
      status: "done",
    });
    expect(d.prepare("SELECT status FROM productions WHERE id='p1'").get() as never).toMatchObject({
      status: "interrupted",
    });
    expect(d.prepare("SELECT status, error_code FROM builds WHERE id='b1'").get() as never).toMatchObject({
      status: "failed",
      error_code: "BACKEND_RESTART",
    });
  });

  it("重启时证据步骤停在 running：步骤标 failed 可重试，模板从 importing 改回 failed", async () => {
    const m = await freshModules();
    m.migrate();
    const d = m.db();
    const now = new Date().toISOString();
    d.prepare("INSERT INTO clients (id, name, created_at) VALUES ('c1', 'C', ?)").run(now);
    for (const id of ["t-run", "t-idle"]) {
      d.prepare(
        `INSERT INTO templates (id, client_id, name, status, created_at, updated_at)
         VALUES (?, 'c1', ?, 'importing', ?, ?)`,
      ).run(id, id, now, now);
    }
    d.prepare(
      `INSERT INTO evidence_steps (id, template_id, step, status, created_at, updated_at)
       VALUES ('e1', 't-run', 'fetch', 'running', ?, ?)`,
    ).run(now, now);

    const changed = m.markStaleRunningAsInterrupted();
    expect(changed.evidence).toBe(1);
    expect(d.prepare("SELECT status, error_code FROM evidence_steps WHERE id='e1'").get() as never).toMatchObject({
      status: "failed",
      error_code: "BACKEND_RESTART",
    });
    // 不改的话步骤条与侧栏都说「进行中」，清单里却是失败待重试（Task 4.4 复审第三轮）
    expect(d.prepare("SELECT status FROM templates WHERE id='t-run'").get() as never).toMatchObject({
      status: "failed",
    });
    // 没有步骤在跑的模板不动
    expect(d.prepare("SELECT status FROM templates WHERE id='t-idle'").get() as never).toMatchObject({
      status: "importing",
    });
  });

  it("删客户在库层级联到模板与出片单位；Agent 任务是多态 owner，库层不级联", async () => {
    const m = await freshModules();
    m.migrate();
    const d = m.db();
    const now = new Date().toISOString();
    d.prepare("INSERT INTO clients (id, name, created_at) VALUES ('c1', 'C', ?)").run(now);
    d.prepare(
      `INSERT INTO templates (id, client_id, name, status, created_at, updated_at)
       VALUES ('t1', 'c1', 'T', 'approved', ?, ?)`,
    ).run(now, now);
    d.prepare(
      `INSERT INTO productions (id, template_id, kind, status, created_at, updated_at)
       VALUES ('p1', 't1', 'variant', 'done', ?, ?)`,
    ).run(now, now);
    d.prepare(`INSERT INTO builds (id, production_id, status, created_at) VALUES ('b1', 'p1', 'done', ?)`).run(now);
    d.prepare(`INSERT INTO assets (id, production_id, created_at) VALUES ('a1', 'p1', ?)`).run(now);
    d.prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, created_at)
       VALUES ('j1', 'production', 'p1', 'done', ?)`,
    ).run(now);
    d.prepare("INSERT INTO agent_messages (job_id, seq, payload, created_at) VALUES ('j1', 1, '{}', ?)").run(now);

    d.prepare("DELETE FROM clients WHERE id = 'c1'").run();

    // 有外键的这几张跟着走
    for (const table of ["templates", "productions", "builds", "assets"]) {
      const n = d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(n.n, `${table} 应被级联清空`).toBe(0);
    }

    // agent_jobs 的 owner 是 (owner_kind, owner_id) 多态引用，SQLite 没法给它外键。
    // Spec 6.2 要求的级联删除只能由应用层的删除流程负责（Phase 3：先停任务、再删目录、最后删库）。
    // 这条断言把这个缺口钉住：库层确实不会清它，实现时别指望数据库兜底。
    const jobs = d.prepare("SELECT COUNT(*) AS n FROM agent_jobs").get() as { n: number };
    expect(jobs.n).toBe(1);

    // agent_messages 挂在 agent_jobs 上，所以只要 job 还在，消息也还在
    const msgs = d.prepare("SELECT COUNT(*) AS n FROM agent_messages").get() as { n: number };
    expect(msgs.n).toBe(1);

    // 但删掉 job 时消息会跟着走
    d.prepare("DELETE FROM agent_jobs WHERE id = 'j1'").run();
    const msgsAfter = d.prepare("SELECT COUNT(*) AS n FROM agent_messages").get() as { n: number };
    expect(msgsAfter.n).toBe(0);
  });
});

describe("加列迁移", () => {
  /**
   * 这条钉的是一个真出过的事故：Task 4.2 先建了 evidence_steps，审查后才加
   * error_raw 列。单测每次建新库所以永远碰不到，而用户的老库里那张表已经存在，
   * schema.sql 的 CREATE TABLE IF NOT EXISTS 不会给它加列——一跑流水线就
   * 「no such column: error_raw」。加列只能走 ALTER。
   */
  it("老库里已有的 evidence_steps 会被补上 error_raw", async () => {
    const { db } = await import("./index.js");
    const m = await import("./migrate.js");
    const d = db();
    // 先把库拉到最新，再退回去造老表——否则 schema_migrations 都还不存在
    m.migrate();

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

    m.migrate();
    expect(columnsOf(d, "evidence_steps")).toContain("error_raw");
  });

  it("老库里的 agent_jobs 补上 prompt / resume_at / updated_at，已有记录原样保留（Task 5.2）", async () => {
    const { db } = await import("./index.js");
    const m = await import("./migrate.js");
    const d = db();
    m.migrate();

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

    m.migrate();
    expect(columnsOf(d, "agent_jobs")).toEqual(expect.arrayContaining(["prompt", "resume_at", "updated_at"]));
    expect(d.prepare("SELECT status, cost_usd, prompt FROM agent_jobs WHERE id = 'old'").get()).toEqual({
      status: "done",
      cost_usd: 0.42,
      prompt: null,
    });
  });

  it("跑第二遍不会重复加列", async () => {
    const { db } = await import("./index.js");
    const m = await import("./migrate.js");
    m.migrate();
    expect(() => m.migrate()).not.toThrow();
    expect(columnsOf(db(), "evidence_steps")).toContain("error_raw");
  });
});

function columnsOf(d: ReturnType<typeof import("./index.js").db>, table: string): string[] {
  return (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}
