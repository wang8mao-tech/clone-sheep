import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataRoot: string;
let closeCurrent: (() => void) | undefined;

async function freshModules() {
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
  const dbMod = await import("../db/index.js");
  const migrateMod = await import("../db/migrate.js");
  closeCurrent = dbMod.closeDb;
  migrateMod.migrate();
  return {
    archive: await import("./archive.js"),
    deletion: await import("./deletion.js"),
    procs: (await import("../lib/procs.js")).procs,
    db: dbMod.db,
  };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-deletion-"));
});

afterEach(() => {
  closeCurrent?.();
  closeCurrent = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

/** 造出 AC-001 的局面：客户 A 下 2 个模板共 5 条成片 */
async function seedClientWithTwoTemplates() {
  const mods = await freshModules();
  const client = mods.archive.createClient("客户 A");
  const first = mods.archive.createTemplate(client.id, "足球榜");
  const second = mods.archive.createTemplate(client.id, "手机横评");
  const now = new Date().toISOString();
  const d = mods.db();

  const productionIds: string[] = [];
  for (const [index, template] of [first, first, first, second, second].entries()) {
    const id = `p${index + 1}`;
    productionIds.push(id);
    d.prepare(
      `INSERT INTO productions (id, template_id, kind, status, created_at, updated_at)
       VALUES (?, ?, 'variant', 'done', ?, ?)`,
    ).run(id, template.id, now, now);
    d.prepare(
      `INSERT INTO builds (id, production_id, status, output_path, created_at)
       VALUES (?, ?, 'done', 'out.mp4', ?)`,
    ).run(`b${index + 1}`, id, now);
  }

  d.prepare(
    `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, created_at) VALUES ('j-tpl', 'template', ?, 'done', ?)`,
  ).run(first.id, now);
  d.prepare(
    `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, created_at) VALUES ('j-prod', 'production', 'p1', 'done', ?)`,
  ).run(now);
  d.prepare(
    `INSERT INTO agent_messages (job_id, seq, role, type, payload, created_at) VALUES ('j-tpl', 1, 'assistant', 'text', '{}', ?)`,
  ).run(now);
  d.prepare(
    `INSERT INTO hypit_calls (subject_kind, subject_id, command, created_at) VALUES ('template', ?, 'check', ?)`,
  ).run(first.id, now);

  return { ...mods, client, first, second, productionIds };
}

describe("AC-001 删除客户级联", () => {
  it("侧栏无 A、磁盘目录不存在、数据库无其记录", async () => {
    const { archive, deletion, db, client } = await seedClientWithTwoTemplates();
    const clientDir = path.join(dataRoot, "clients", client.id);
    expect(existsSync(clientDir)).toBe(true);

    const impact = await deletion.deleteClient(client.id);
    expect(impact).toMatchObject({ kind: "client", name: "客户 A", templates: 2, productions: 5 });

    expect(archive.listClients()).toEqual([]);
    expect(existsSync(clientDir)).toBe(false);

    const d = db();
    const count = (sql: string): number => (d.prepare(sql).get() as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM clients")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM templates")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM productions")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM builds")).toBe(0);
    // 多态 owner 没有外键，必须显式清理，否则留孤儿
    expect(count("SELECT COUNT(*) AS n FROM agent_jobs")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM agent_messages")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM hypit_calls")).toBe(0);
  });

  it("回收区不留残骸", async () => {
    const { deletion, client } = await seedClientWithTwoTemplates();
    await deletion.deleteClient(client.id);
    const trash = path.join(dataRoot, ".trash");
    expect(existsSync(trash) ? readdirSync(trash) : []).toEqual([]);
  });
});

describe("删除模板", () => {
  it("只删自己，同客户的兄弟模板与其成片不受影响", async () => {
    const { archive, deletion, db, first, second } = await seedClientWithTwoTemplates();
    const firstDir = first.workspace_path as string;
    const secondDir = second.workspace_path as string;

    await deletion.deleteTemplate(first.id);

    expect(existsSync(firstDir)).toBe(false);
    expect(existsSync(secondDir)).toBe(true);
    expect(archive.listClients()[0]?.templates.map((t) => t.name)).toEqual(["手机横评"]);

    const d = db();
    expect((d.prepare("SELECT COUNT(*) AS n FROM productions").get() as { n: number }).n).toBe(2);
    expect((d.prepare("SELECT COUNT(*) AS n FROM agent_jobs").get() as { n: number }).n).toBe(0);
  });

  it("对象不存在时报 404", async () => {
    const { deletion } = await freshModules();
    await expect(deletion.deleteTemplate("不存在的-id")).rejects.toMatchObject({
      code: "TEMPLATE_NOT_FOUND",
      status: 404,
    });
  });
});

describe("删除前中止关联任务（AC-002 的可验部分）", () => {
  it("先停 Agent 会话再删目录：停的时候目录还在，返回时任务已结束", async () => {
    const mods = await freshModules();
    const stopper = await import("./agent-stopper.js");
    const { archive, deletion } = mods;
    const client = archive.createClient("客户 A");
    const template = archive.createTemplate(client.id, "足球榜");
    const ws = template.workspace_path as string;
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, "ANALYSIS.md"), "x");

    const seen: { owners: string[]; dirExisted: boolean }[] = [];
    stopper.setAgentStopper((owners) => {
      // 停任务这一步必须发生在删目录之前：会话还在写这个目录
      seen.push({ owners: owners.map((o) => `${o.kind}:${o.id}`), dirExisted: existsSync(ws) });
      return Promise.resolve(owners.length);
    });
    try {
      await deletion.deleteTemplate(template.id);
    } finally {
      stopper.setAgentStopper(undefined);
    }

    expect(seen).toEqual([{ owners: [`template:${template.id}`], dirExisted: true }]);
    expect(existsSync(ws)).toBe(false);
  });

  it("没注册停止函数时照常能删（Agent 还没接进来的场合）", async () => {
    const { archive, deletion } = await freshModules();
    const client = archive.createClient("客户 B");
    const template = archive.createTemplate(client.id, "篮球榜");
    mkdirSync(template.workspace_path as string, { recursive: true });
    await expect(deletion.deleteTemplate(template.id)).resolves.toMatchObject({ kind: "template" });
  });

  it("impact 统计运行中的 Agent 会话与出片", async () => {
    const { archive, deletion, db } = await freshModules();
    const client = archive.createClient("客户 A");
    const template = archive.createTemplate(client.id, "足球榜");
    const now = new Date().toISOString();
    const d = db();
    d.prepare(
      `INSERT INTO productions (id, template_id, kind, status, created_at, updated_at)
       VALUES ('p1', ?, 'variant', 'building', ?, ?)`,
    ).run(template.id, now, now);
    d.prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, created_at) VALUES ('j1', 'template', ?, 'running', ?)`,
    ).run(template.id, now);
    d.prepare(`INSERT INTO builds (id, production_id, status, created_at) VALUES ('b1', 'p1', 'running', ?)`).run(now);

    expect(deletion.templateImpact(template.id).runningTasks).toBe(2);
    expect(deletion.clientImpact(client.id).runningTasks).toBe(2);
  });

  it("删除返回时真实子进程已经退出，不是发完信号就走（AC-002）", async () => {
    const { archive, deletion, procs } = await freshModules();
    const client = archive.createClient("客户 A");
    const template = archive.createTemplate(client.id, "足球榜");

    // 用真进程而不是 mock：这条用例要证的就是"等到它退出"这件事本身，
    // 把 killBySubject 换成 mock 就等于把被测行为换掉了
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    procs.register(child, "假装在跑的渲染", { kind: "template", id: template.id });
    expect(child.exitCode).toBeNull();

    await deletion.deleteTemplate(template.id);

    // deleteTemplate 返回的这一刻进程必须已经收尸，否则它还攥着工作目录的句柄
    expect(child.exitCode === null && child.signalCode === null).toBe(false);
    expect(procs.size).toBe(0);
  });

  it("不属于这个对象的子进程不受牵连", async () => {
    const { archive, deletion, procs } = await freshModules();
    const client = archive.createClient("客户 A");
    const doomed = archive.createTemplate(client.id, "足球榜");
    const bystander = archive.createTemplate(client.id, "手机横评");

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    procs.register(child, "别人的活", { kind: "template", id: bystander.id });

    await deletion.deleteTemplate(doomed.id);
    expect(child.exitCode).toBeNull();

    child.kill("SIGKILL");
    await once(child, "exit");
  });
});

describe("失败回滚", () => {
  /**
   * 走真实的 deleteClient 入口，用 SQLite 触发器把删库那一步按死。
   * 直接调 removeWithRollback 是测不到编排的——真实路径上"杀进程"排在它前面，
   * 绕开入口就等于把那一步连同它的副作用一起跳过了。
   */
  function armDeleteFailure(d: ReturnType<typeof import("../db/index.js").db>): void {
    d.exec(
      `CREATE TRIGGER block_client_delete BEFORE DELETE ON clients
         BEGIN SELECT RAISE(ABORT, '模拟删库失败'); END;`,
    );
  }

  it("删库失败时目录原样挪回、记录保留、回收区不留东西", async () => {
    const { archive, deletion, db, client } = await seedClientWithTwoTemplates();
    const clientDir = path.join(dataRoot, "clients", client.id);
    const marker = path.join(clientDir, "marker.txt");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(marker, "keep me", "utf8");
    armDeleteFailure(db());

    await expect(deletion.deleteClient(client.id)).rejects.toMatchObject({ code: "DB_DELETE_FAILED" });

    expect(existsSync(marker)).toBe(true);
    expect(archive.listClients()).toHaveLength(1);
    const d = db();
    const count = (sql: string): number => (d.prepare(sql).get() as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM templates")).toBe(2);
    // 同一事务里的孤儿清理也必须一起回滚，不能只把 owner 留下、把它的记录删了
    expect(count("SELECT COUNT(*) AS n FROM agent_jobs")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM hypit_calls")).toBe(1);
    const trash = path.join(dataRoot, ".trash");
    expect(existsSync(trash) ? readdirSync(trash) : []).toEqual([]);
  });

  it("删除失败 + 停止函数已注册（生产的样子）：任务仍是中断，用户还能继续（复审 M-2）", async () => {
    const mods = await freshModules();
    const stopper = await import("./agent-stopper.js");
    const { archive, deletion, db } = mods;
    const client = archive.createClient("客户 A");
    const template = archive.createTemplate(client.id, "足球榜");
    mkdirSync(template.workspace_path as string, { recursive: true });
    const now = new Date().toISOString();
    const d = db();
    d.prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, session_id, created_at)
       VALUES ('j1', 'template', ?, 'running', 's-1', ?)`,
    ).run(template.id, now);
    // 真实现停完是「中断」（scheduler.stopOwner 默认 abort）
    stopper.setAgentStopper((owners) => {
      d.prepare(`UPDATE agent_jobs SET status = 'interrupted', stop_reason = 'user_abort' WHERE owner_id = ?`).run(
        owners[0]!.id,
      );
      return Promise.resolve(owners.length);
    });
    armDeleteFailure(d); // 触发器拦的是删客户那一步
    try {
      await expect(deletion.deleteClient(client.id)).rejects.toMatchObject({ code: "DB_DELETE_FAILED" });
    } finally {
      stopper.setAgentStopper(undefined);
    }

    // 中断才能「继续」；写成 cancelled 的话用户只剩重跑，白扔掉已经花钱跑出来的半成品
    const row = d.prepare("SELECT status FROM agent_jobs WHERE id = 'j1'").get() as { status: string };
    expect(row.status).toBe("interrupted");
  });

  it("停任务本身失败（比如停止超时）：不删目录，错误照实往上报（复审：AC-002 fail closed）", async () => {
    const mods = await freshModules();
    const stopper = await import("./agent-stopper.js");
    const { archive, deletion } = mods;
    const client = archive.createClient("客户 A");
    const template = archive.createTemplate(client.id, "足球榜");
    const ws = template.workspace_path as string;
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, "ANALYSIS.md"), "x");

    stopper.setAgentStopper(() =>
      Promise.reject(Object.assign(new Error("Agent 会话没能在预期时间内停下"), { code: "STOP_TIMEOUT", status: 504 })),
    );
    try {
      await expect(deletion.deleteTemplate(template.id)).rejects.toMatchObject({ code: "STOP_TIMEOUT" });
    } finally {
      stopper.setAgentStopper(undefined);
    }

    // 进程可能还攥着目录：一个文件都不能动，对象也还在
    expect(existsSync(path.join(ws, "ANALYSIS.md"))).toBe(true);
    expect(mods.archive.findTemplate(template.id)).toBeDefined();
  });

  it("删除失败后，运行中的任务被写成中断而不是已取消——进程真被杀了，但对象还在", async () => {
    const { archive, deletion, db } = await freshModules();
    const client = archive.createClient("客户 A");
    const template = archive.createTemplate(client.id, "足球榜");
    const now = new Date().toISOString();
    const d = db();
    d.prepare(
      `INSERT INTO productions (id, template_id, kind, status, created_at, updated_at)
       VALUES ('p1', ?, 'variant', 'building', ?, ?)`,
    ).run(template.id, now, now);
    d.prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, resume_at, created_at)
       VALUES ('j1', 'template', ?, 'awaiting_quota', '2026-09-23T10:00:00.000Z', ?)`,
    ).run(template.id, now);
    d.prepare(`INSERT INTO builds (id, production_id, status, created_at) VALUES ('b1', 'p1', 'running', ?)`).run(now);
    armDeleteFailure(d);

    await expect(deletion.deleteClient(client.id)).rejects.toMatchObject({ code: "DB_DELETE_FAILED" });

    const one = (sql: string): Record<string, unknown> => d.prepare(sql).get() as Record<string, unknown>;
    expect(one("SELECT status, stop_reason, resume_at FROM agent_jobs WHERE id = 'j1'")).toEqual({
      status: "interrupted",
      stop_reason: "delete_aborted",
      // 进程都被杀了，留着续跑时间界面会说「将自动续跑」，但那个定时器早没了
      resume_at: null,
    });
    expect(one("SELECT status FROM productions WHERE id = 'p1'")).toEqual({ status: "interrupted" });
    // builds 的状态表里没有 interrupted，按既有约定落到 failed 并带错误码
    expect(one("SELECT status, error_code FROM builds WHERE id = 'b1'")).toEqual({
      status: "failed",
      error_code: "DELETE_ABORTED",
    });
  });

  it("成功删除时不写这些状态，行直接没了", async () => {
    const { archive, deletion, db } = await freshModules();
    const client = archive.createClient("客户 A");
    const template = archive.createTemplate(client.id, "足球榜");
    const now = new Date().toISOString();
    db()
      .prepare(
        `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, created_at) VALUES ('j1', 'template', ?, 'running', ?)`,
      )
      .run(template.id, now);

    await deletion.deleteClient(client.id);
    expect((db().prepare("SELECT COUNT(*) AS n FROM agent_jobs").get() as { n: number }).n).toBe(0);
  });
});

describe("启动期清扫 .trash", () => {
  it("把上次删除残留的目录清掉，并报出清了几个", async () => {
    const { deletion } = await freshModules();
    const trash = path.join(dataRoot, ".trash");
    // 名字照生产的样子取：回收区条目名来自 path.basename(工作目录)，是 UUID，
    // 全是 ASCII。本机上 rmSync 对中文名目录会静默不删，拿中文名来测等于在测
    // 一个生产根本走不到的路径（见 DEV-PLAN 已知风险）
    mkdirSync(path.join(trash, "8ba62e60-9ee5-43d5-b021-a1f8f5bf3499-1789877172413"), { recursive: true });
    mkdirSync(path.join(trash, "a6562a0a-0bab-4484-8aa2-9e2d7127e3a2-1789877172999"), { recursive: true });
    writeFileSync(path.join(trash, "8ba62e60-9ee5-43d5-b021-a1f8f5bf3499-1789877172413", "a.txt"), "x", "utf8");

    expect(deletion.purgeTrash()).toBe(2);
    expect(readdirSync(trash)).toEqual([]);
  });

  it("没有 .trash 时什么都不做，不报错", async () => {
    const { deletion } = await freshModules();
    expect(deletion.purgeTrash()).toBe(0);
  });
});
