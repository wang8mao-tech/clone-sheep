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

    const impact = deletion.deleteClient(client.id);
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
    deletion.deleteClient(client.id);
    const trash = path.join(dataRoot, ".trash");
    expect(existsSync(trash) ? readdirSync(trash) : []).toEqual([]);
  });
});

describe("删除模板", () => {
  it("只删自己，同客户的兄弟模板与其成片不受影响", async () => {
    const { archive, deletion, db, client, first, second } = await seedClientWithTwoTemplates();
    const firstDir = first.workspace_path as string;
    const secondDir = second.workspace_path as string;

    deletion.deleteTemplate(first.id);

    expect(existsSync(firstDir)).toBe(false);
    expect(existsSync(secondDir)).toBe(true);
    expect(archive.listClients()[0]?.templates.map((t) => t.name)).toEqual(["手机横评"]);

    const d = db();
    expect((d.prepare("SELECT COUNT(*) AS n FROM productions").get() as { n: number }).n).toBe(2);
    expect((d.prepare("SELECT COUNT(*) AS n FROM agent_jobs").get() as { n: number }).n).toBe(0);
  });

  it("对象不存在时报 404", async () => {
    const { deletion } = await freshModules();
    try {
      deletion.deleteTemplate("不存在的-id");
      expect.unreachable("应当抛 TEMPLATE_NOT_FOUND");
    } catch (error) {
      expect((error as { status: number }).status).toBe(404);
    }
  });
});

describe("删除前中止关联任务（AC-002 的可验部分）", () => {
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
    d.prepare(
      `INSERT INTO builds (id, production_id, status, created_at) VALUES ('b1', 'p1', 'running', ?)`,
    ).run(now);

    expect(deletion.templateImpact(template.id).runningTasks).toBe(2);
    expect(deletion.clientImpact(client.id).runningTasks).toBe(2);
  });

  it("删除前先按对象杀子进程，再动库和目录", async () => {
    const { archive, deletion, procs } = await freshModules();
    const client = archive.createClient("客户 A");
    const template = archive.createTemplate(client.id, "足球榜");

    const killed: string[] = [];
    const spy = vi.spyOn(procs, "killBySubject").mockImplementation((match) => {
      if (match({ kind: "template", id: template.id })) killed.push(template.id);
      return killed.length;
    });

    deletion.deleteTemplate(template.id);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(killed).toEqual([template.id]);
    spy.mockRestore();
  });
});

describe("失败回滚", () => {
  it("删库失败时目录原样挪回，记录保留", async () => {
    const { archive, deletion, db, client } = await seedClientWithTwoTemplates();
    const clientDir = path.join(dataRoot, "clients", client.id);
    const marker = path.join(clientDir, "marker.txt");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(marker, "keep me", "utf8");

    expect(() =>
      deletion.removeWithRollback([clientDir], () => {
        throw new Error("模拟删库失败");
      }),
    ).toThrowError(/数据库未能删除记录/);

    expect(existsSync(marker)).toBe(true);
    expect(archive.listClients()).toHaveLength(1);
    expect((db().prepare("SELECT COUNT(*) AS n FROM templates").get() as { n: number }).n).toBe(2);
  });
});
