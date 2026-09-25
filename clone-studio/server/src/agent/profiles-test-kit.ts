import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * 模型档案测试的底座：每个用例一个临时数据根（库 + secrets.json），用完关库再删。
 * 数据根必须在系统临时目录下：万一环境变量没设上，宁可抛错也不碰用户的真实数据根。
 */

let dataRoot = "";
let close: (() => void) | undefined;

export function useProfileSandbox(): () => string {
  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(tmpdir(), "cs-prof-"));
    process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
    vi.resetModules();
  });
  afterEach(() => {
    close?.();
    close = undefined;
    rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.CLONE_STUDIO_DATA_ROOT;
    vi.restoreAllMocks();
  });
  return () => dataRoot;
}

export async function bootProfiles() {
  const config = await import("../config.js");
  if (!path.resolve(config.paths.db).startsWith(path.resolve(tmpdir()))) {
    throw new Error(`测试库不在临时目录下：${config.paths.db}`);
  }
  const database = await import("../db/index.js");
  const { migrate } = await import("../db/migrate.js");
  migrate();
  close = database.closeDb;
  const profiles = await import("./profiles.js");
  const secrets = await import("../lib/secrets.js");
  return { db: database.db, migrate, profiles, secrets, paths: config.paths };
}

/** 一个兼容端点档案的合法输入 */
export const COMPATIBLE = {
  name: "DeepSeek",
  kind: "compatible" as const,
  baseUrl: "https://api.deepseek.com/anthropic/",
  token: "sk-deepseek-1234567890abcd",
  modelId: "deepseek-flash",
  fastModelId: "",
  supportsVision: true,
  supportsWebSearch: true,
  priceIn: 0.27,
  priceOut: 1.1,
};
