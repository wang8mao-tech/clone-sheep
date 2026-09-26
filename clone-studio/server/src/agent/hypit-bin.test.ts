import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 先设数据根再动态 import（config 在 import 时算路径），与 plugin.test.ts 同一写法 */
let dataRoot: string;
let fakeCli: string;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "cs-hypit-bin-"));
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  // 目录带空格：生产默认 hypit-main 就在 X:\workflow\clone workflow\ 下
  const cliDir = path.join(dataRoot, "fake hypit", "bin");
  mkdirSync(cliDir, { recursive: true });
  fakeCli = path.join(cliDir, "hypit.mjs");
  writeFileSync(fakeCli, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  vi.resetModules();
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

describe("ensureHypitBin（复审 S1-H6：Agent 敲 hypit 就能用）", () => {
  it("在数据根下放 hypit.cmd 与 sh 版 hypit", async () => {
    const { ensureHypitBin } = await import("./hypit-bin.js");
    const dir = ensureHypitBin(process.execPath, fakeCli);
    expect(dir).toBe(path.join(dataRoot, "agent-bin"));
    expect(readFileSync(path.join(dir, "hypit.cmd"), "utf8")).toContain(fakeCli);
    expect(readFileSync(path.join(dir, "hypit"), "utf8")).toMatch(/^#!\/bin\/sh\n/);
  });

  it.runIf(process.platform === "win32")("hypit.cmd 真能转调，参数原样传过去（含空格）", async () => {
    const { ensureHypitBin } = await import("./hypit-bin.js");
    const dir = ensureHypitBin(process.execPath, fakeCli);
    const r = spawnSync("cmd.exe", ["/d", "/c", "hypit", "check", "a.svml", "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    expect(JSON.parse(r.stdout)).toEqual(["check", "a.svml", "--json"]);
  });

  it("sh 版真能转调（有 sh 时）", async () => {
    const probe = spawnSync("sh", ["-c", "exit 0"]);
    if (probe.error) return;
    const { ensureHypitBin } = await import("./hypit-bin.js");
    const dir = ensureHypitBin(process.execPath, fakeCli);
    const r = spawnSync("sh", [path.join(dir, "hypit"), "check", "my file.svml"], { encoding: "utf8" });
    expect(JSON.parse(r.stdout)).toEqual(["check", "my file.svml"]);
  });

  it("内容没变不重写", async () => {
    const { ensureHypitBin } = await import("./hypit-bin.js");
    const dir = ensureHypitBin(process.execPath, fakeCli);
    const before = statSync(path.join(dir, "hypit.cmd")).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    ensureHypitBin(process.execPath, fakeCli);
    expect(statSync(path.join(dir, "hypit.cmd")).mtimeMs).toBe(before);
  });
});
