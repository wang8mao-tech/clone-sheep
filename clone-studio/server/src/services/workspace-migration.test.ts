import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataRoot: string;
let closeCurrent: (() => void) | undefined;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-wsmig-"));
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
});

afterEach(() => {
  // 关句柄本身可能抛，不能让它盖掉用例真正的失败原因
  try {
    closeCurrent?.();
  } catch {
    // 句柄已经没了就算了
  }
  closeCurrent = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

/** 造一个 Phase 2 形态的存量模板：有 profile，既没选中也没有 references/src */
async function seedLegacy() {
  const dbMod = await import("../db/index.js");
  const migrateMod = await import("../db/migrate.js");
  const archive = await import("./archive.js");
  const migration = await import("./workspace-migration.js");
  closeCurrent = dbMod.closeDb;
  migrateMod.migrate();

  const client = archive.createClient("老王工作室");
  const template = archive.createTemplate(client.id, "足球榜");
  const dir = template.workspace_path as string;
  rmSync(path.join(dir, ".hypit"), { recursive: true, force: true });
  rmSync(path.join(dir, "references"), { recursive: true, force: true });
  return { migration, dir, db: dbMod.db };
}

describe("migrateWorkspaces", () => {
  it("把存量模板补成已选中，并补出 references/src", async () => {
    const { migration, dir } = await seedLegacy();
    expect(existsSync(path.join(dir, ".hypit", "runtime"))).toBe(false);
    expect(existsSync(path.join(dir, "references", "src"))).toBe(false);

    expect(migration.migrateWorkspaces()).toEqual({ repaired: 1, intact: 0, failures: [] });

    expect(existsSync(path.join(dir, ".hypit", "runtime"))).toBe(true);
    // 少了这个，Phase 4 往 references/src/source.mp4 落盘时只有存量模板会 ENOENT
    expect(existsSync(path.join(dir, "references", "src"))).toBe(true);
  });

  it("第二遍报 intact 而不是 repaired——运维要能确认修复到底生效没有", async () => {
    const { migration } = await seedLegacy();
    migration.migrateWorkspaces();
    expect(migration.migrateWorkspaces()).toEqual({ repaired: 0, intact: 1, failures: [] });
  });

  it("补不了的模板要说出是哪个、为什么，而不是只报一个计数", async () => {
    const { migration, dir } = await seedLegacy();
    rmSync(dir, { recursive: true, force: true });

    const result = migration.migrateWorkspaces();
    expect(result).toMatchObject({ repaired: 0, intact: 0 });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.workspacePath).toBe(dir);
    expect(result.failures[0]?.reason).toMatch(/缺少 hypit\.runtime\.json/);
  });

  it("一个模板补不了不影响别的模板", async () => {
    const { migration, dir } = await seedLegacy();
    const archive = await import("./archive.js");
    const second = archive.createTemplate((archive.listClients()[0] as { id: string }).id, "手机横评");
    rmSync(path.join(second.workspace_path as string, ".hypit"), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });

    const result = migration.migrateWorkspaces();
    expect(result.repaired).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(existsSync(path.join(second.workspace_path as string, ".hypit", "runtime"))).toBe(true);
  });

  it("没有任何模板时安静返回，不拦启动", async () => {
    const dbMod = await import("../db/index.js");
    const migrateMod = await import("../db/migrate.js");
    const migration = await import("./workspace-migration.js");
    closeCurrent = dbMod.closeDb;
    migrateMod.migrate();

    expect(migration.migrateWorkspaces()).toEqual({ repaired: 0, intact: 0, failures: [] });
  });
});
