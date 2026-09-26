import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** settingsFromDb 是 Task 5.2 里唯一直接读 settings 行的地方：列名改了要在这里红，而不是运行时才发现 */
let dataRoot: string;
let closeDb: (() => void) | undefined;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "cs-settings-"));
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
});

afterEach(() => {
  closeDb?.();
  closeDb = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

describe("settingsFromDb", () => {
  it("读迁移建出来的 settings 行，拿到 REQ-008 的默认值", async () => {
    const dbMod = await import("../db/index.js");
    const { migrate } = await import("../db/migrate.js");
    const { settingsFromDb } = await import("./agent-settings.js");
    closeDb = dbMod.closeDb;
    migrate();
    expect(settingsFromDb()).toEqual({ timeoutMinutes: 45, budgetUsd: 5, concurrency: 2 });

    dbMod
      .db()
      .prepare("UPDATE settings SET agent_timeout_minutes = 30, agent_budget_usd = 2.5, agent_concurrency = 1")
      .run();
    expect(settingsFromDb()).toEqual({ timeoutMinutes: 30, budgetUsd: 2.5, concurrency: 1 });
  });
});
