import { describe, expect, it } from "vitest";
import { freshModules } from "./migrate-test-kit.js";

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
