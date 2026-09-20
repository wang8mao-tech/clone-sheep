import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 契约测试：我们手写的 Runtime Profile 选择，真 hypit 还认不认。
 *
 * `ensureRuntimeSelected` 不 spawn `hypit runtime use`，而是直接写
 * `.hypit/runtime` 与 `.hypit/.gitignore`——那个取舍让单测快了四十多秒，代价是
 * hypit 一旦改了这个格式，我们会在用户导入参考视频那一刻才发现，而且此时所有
 * 新建模板都已经坏了。
 *
 * 这个文件就是那份保险：整套只 spawn 一次（约 2 秒），把失效变成一条红的测试。
 * hypit CLI 不在时整组跳过——它不该成为「没装 hypit 就跑不了单测」的理由。
 */

const HYPIT_CLI = path.resolve(process.cwd(), "..", "..", "hypit-main", "bin", "hypit.mjs");
const hasHypit = existsSync(HYPIT_CLI);

describe.skipIf(!hasHypit)("hypit 契约：手写的 Runtime Profile 选择", () => {
  let dataRoot: string;
  let dir: string;

  beforeAll(async () => {
    dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-contract-"));
    process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
    const { createWorkspace } = await import("./workspace.js");
    dir = createWorkspace({
      clientId: "c-contract",
      templateId: "t-contract",
      slug: "契约",
      services: { tokendance: false, hypihub: false, whisperx: true, renderWorkers: 1, renderConcurrency: 1 },
    }).dir;
  });

  afterAll(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.CLONE_STUDIO_DATA_ROOT;
  });

  it("hypit doctor 认这个工程，且认的就是我们写的那个选择文件", () => {
    const run = spawnSync(process.execPath, [HYPIT_CLI, "doctor", "--workspace", dir, "--json"], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    const parsed = JSON.parse(lastJson(run.stdout)) as {
      format?: string;
      profileSource?: string;
      selectionFile?: string;
      profile?: string;
      error?: { code: string; message: string };
    };

    // 失败时把原文带出来：这条红了说明 hypit 改了契约，排障要看它到底说了什么
    expect(parsed.error, run.stdout || run.stderr).toBeUndefined();
    expect(parsed.profileSource).toBe("project");
    expect(parsed.selectionFile).toBe(path.join(dir, ".hypit", "runtime"));
    expect(parsed.profile).toBe(path.join(dir, "hypit.runtime.json"));
  });
});

/** --json 下 stdout 就是一整份 JSON，但前面可能垫着进度行，从第一个 { 取到底 */
function lastJson(stdout: string): string {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error(`hypit 没有给出 JSON：${stdout}`);
  return stdout.slice(start);
}
