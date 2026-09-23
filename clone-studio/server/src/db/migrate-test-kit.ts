import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * 迁移测试的公共装置。迁移与启动清理是有副作用的模块（会按 config 建目录、开库），
 * 所以每个用例都换一个临时数据根目录，再动态 import 让模块重新初始化。
 * 每个测试文件各自 import：vitest 默认按文件隔离模块，beforeEach / afterEach 也按文件注册。
 */
let dataRoot: string;
let closeCurrent: (() => void) | undefined;

export async function freshModules() {
  // 带 query 的动态 import 在 Vite 下不成立（Unknown variable dynamic import），
  // 用 resetModules 清模块注册表，再静态说明符重新求值。
  vi.resetModules();
  assertTempRoot();
  const dbMod = await import("./index.js");
  const migrateMod = await import("./migrate.js");
  closeCurrent = dbMod.closeDb;
  return { ...dbMod, ...migrateMod };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-test-"));
  // 环境变量在这里就设好，不放在 freshModules 里：这些用例会 DROP TABLE，谁要是直接
  // import ./index.js（不走 freshModules），config 就会回落到默认的 ~/.clone-studio，
  // 一跑就把用户的生产库删表重建。真发生过一次，见下面的 assertTempRoot
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
});

afterEach(() => {
  // 先关库再删目录：SQLite 在 Windows 上持有文件句柄，不关会 EPERM
  closeCurrent?.();
  closeCurrent = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

/**
 * 最后一道闸：库的路径必须落在临时目录里。环境变量漏设、模块被别处先 import 走，
 * 都会让 config 回落到默认数据根目录——那是用户的生产库，而这些用例是 DROP TABLE 级别的。
 */
export function assertTempRoot(): void {
  const root = process.env.CLONE_STUDIO_DATA_ROOT;
  if (!root) throw new Error("CLONE_STUDIO_DATA_ROOT 没设：迁移测试会打到用户的生产库");
  const real = path.resolve(root);
  if (!real.toLowerCase().startsWith(path.resolve(tmpdir()).toLowerCase())) {
    throw new Error(`拒绝在非临时目录上跑迁移测试：${real}`);
  }
}

export function columnsOf(d: ReturnType<typeof import("./index.js").db>, table: string): string[] {
  return (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}
