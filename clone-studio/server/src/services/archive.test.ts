import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * archive 通过 config 定位数据根目录、通过 db 开库，都是有副作用的模块，
 * 所以每个用例换一个临时数据根目录再动态 import，写法与 db/migrate.test.ts 一致。
 */
let dataRoot: string;
let closeCurrent: (() => void) | undefined;

async function freshArchive() {
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
  const dbMod = await import("../db/index.js");
  const migrateMod = await import("../db/migrate.js");
  closeCurrent = dbMod.closeDb;
  migrateMod.migrate();
  return { ...(await import("./archive.js")), db: dbMod.db };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-archive-"));
});

afterEach(() => {
  closeCurrent?.();
  closeCurrent = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

describe("客户名校验", () => {
  it("去首尾空格后入库", async () => {
    const archive = await freshArchive();
    const client = archive.createClient("  星途 MCN  ");
    expect(client.name).toBe("星途 MCN");
  });

  it("空名与纯空格都拒绝", async () => {
    const archive = await freshArchive();
    expect(() => archive.createClient("   ")).toThrowError(/不能为空/);
  });

  it("40 字放行，41 字拒绝", async () => {
    const archive = await freshArchive();
    expect(archive.createClient("客".repeat(40)).name).toHaveLength(40);
    expect(() => archive.createClient("客".repeat(41))).toThrowError(/最长 40 字/);
  });

  it("重名拒绝并给出 NAME_TAKEN", async () => {
    const archive = await freshArchive();
    archive.createClient("星途 MCN");
    try {
      archive.createClient("星途 MCN");
      expect.unreachable("重名应当抛错");
    } catch (error) {
      expect((error as { code: string }).code).toBe("NAME_TAKEN");
      expect((error as { status: number }).status).toBe(409);
    }
  });

  it("改名到自己原来的名字不算重名", async () => {
    const archive = await freshArchive();
    const client = archive.createClient("星途 MCN");
    expect(archive.renameClient(client.id, "星途 MCN").name).toBe("星途 MCN");
  });
});

describe("模板名校验（AC-003）", () => {
  it("同客户下同名拒绝，不同客户下同名放行", async () => {
    const archive = await freshArchive();
    const a = archive.createClient("星途 MCN");
    const b = archive.createClient("北岸数码");
    archive.createTemplate(a.id, "足球榜");

    try {
      archive.createTemplate(a.id, "足球榜");
      expect.unreachable("同客户下重名应当抛错");
    } catch (error) {
      expect((error as { code: string }).code).toBe("NAME_TAKEN");
      expect((error as Error).message).toBe("名称已存在");
    }

    expect(archive.createTemplate(b.id, "足球榜").name).toBe("足球榜");
  });

  it("60 字放行，61 字拒绝", async () => {
    const archive = await freshArchive();
    const client = archive.createClient("星途 MCN");
    expect(archive.createTemplate(client.id, "模".repeat(60)).name).toHaveLength(60);
    expect(() => archive.createTemplate(client.id, "模".repeat(61))).toThrowError(/最长 60 字/);
  });

  it("客户不存在时报 404", async () => {
    const archive = await freshArchive();
    try {
      archive.createTemplate("不存在的-id", "足球榜");
      expect.unreachable("应当抛 CLIENT_NOT_FOUND");
    } catch (error) {
      expect((error as { status: number }).status).toBe(404);
    }
  });
});

describe("建模板即建工程目录", () => {
  it("目录、package.json、hypit.runtime.json 都落盘，workspace_path 入库", async () => {
    const archive = await freshArchive();
    const client = archive.createClient("星途 MCN");
    const template = archive.createTemplate(client.id, "足球榜");

    const dir = template.workspace_path;
    expect(dir).toBeTruthy();
    expect(existsSync(path.join(dir as string, "package.json"))).toBe(true);

    const profile = JSON.parse(readFileSync(path.join(dir as string, "hypit.runtime.json"), "utf8")) as {
      format: string;
      endpoints: Record<string, unknown>;
    };
    expect(profile.format).toBe("hypit.runtime-local@1");
    // 凭据未验证时不写 TokenDance endpoint，plan 会明确报缺能力而不是拿坏 key 去打
    expect(profile.endpoints).not.toHaveProperty("tokendance.default");
    expect(profile.endpoints).toHaveProperty("hyperframes.local");
  });

  it("TokenDance 验证过之后建的模板才写它的 endpoint", async () => {
    const archive = await freshArchive();
    archive.db()
      .prepare("UPDATE settings SET tokendance_verified_at = ? WHERE id = 1")
      .run(new Date().toISOString());

    const client = archive.createClient("星途 MCN");
    const template = archive.createTemplate(client.id, "足球榜");
    const profile = JSON.parse(
      readFileSync(path.join(template.workspace_path as string, "hypit.runtime.json"), "utf8"),
    ) as { endpoints: Record<string, unknown> };
    expect(profile.endpoints).toHaveProperty("tokendance.default");
  });
});

describe("侧栏树与统计", () => {
  it("按客户分组，模板挂在各自客户下", async () => {
    const archive = await freshArchive();
    const a = archive.createClient("星途 MCN");
    archive.createClient("北岸数码");
    archive.createTemplate(a.id, "足球榜");
    archive.createTemplate(a.id, "手机横评");

    const tree = archive.listClients();
    expect(tree).toHaveLength(2);
    expect(tree[0]?.templates.map((t) => t.name)).toEqual(["足球榜", "手机横评"]);
    expect(tree[0]?.templates[0]?.status).toBe("importing");
    expect(tree[1]?.templates).toEqual([]);
  });

  it("新模板的统计是真实的零，不是占位", async () => {
    const archive = await freshArchive();
    const client = archive.createClient("星途 MCN");
    const template = archive.createTemplate(client.id, "足球榜");
    const stats = archive.templateStats(template);
    expect(stats).toMatchObject({ outputs: 0, totalCostUsd: 0, costIsEstimate: false });
    expect(stats.lastActivityAt).toBe(template.updated_at);
  });

  it("有 Agent 花费与 build 估价时合计并标为估算", async () => {
    const archive = await freshArchive();
    const client = archive.createClient("星途 MCN");
    const template = archive.createTemplate(client.id, "足球榜");
    const now = new Date().toISOString();
    const d = archive.db();

    d.prepare(
      `INSERT INTO productions (id, template_id, kind, status, created_at, updated_at)
       VALUES ('p1', ?, 'replica', 'done', ?, ?)`,
    ).run(template.id, now, now);
    d.prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, cost_usd, cost_is_estimate, created_at)
       VALUES ('j1', 'template', ?, 'done', 0.42, 1, ?)`,
    ).run(template.id, now);
    d.prepare(
      `INSERT INTO builds (id, production_id, estimate_usd, status, created_at)
       VALUES ('b1', 'p1', 0.5, 'done', ?)`,
    ).run(now);

    const stats = archive.templateStats(template);
    expect(stats.outputs).toBe(1);
    expect(stats.totalCostUsd).toBeCloseTo(0.92, 6);
    expect(stats.costIsEstimate).toBe(true);
  });
});
