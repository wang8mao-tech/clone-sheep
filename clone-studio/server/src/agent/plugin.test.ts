import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * config 在 import 时算好路径，所以先设环境变量、resetModules 再动态 import，
 * 与 archive.test.ts 同一写法——顺序反了会写进用户的 ~/.clone-studio。
 */
let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "cs-plugin-"));
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
  delete process.env.CLONE_STUDIO_HYPIT_ROOT;
});

describe("ensureAgentPlugin", () => {
  it("在数据根下铺出插件：manifest + skills/hypit（从 hypit-main 复制）", async () => {
    const { ensureAgentPlugin } = await import("./plugin.js");
    const dir = ensureAgentPlugin();
    expect(dir).toBe(path.join(dataRoot, "agent-plugin"));
    const manifest = JSON.parse(readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")) as {
      name: string;
    };
    expect(manifest.name).toBe("clone-studio");
    expect(existsSync(path.join(dir, "skills", "hypit", "SKILL.md"))).toBe(true);
  });

  it("hypit 没变就不重铺（指纹相同直接返回）", async () => {
    const { ensureAgentPlugin } = await import("./plugin.js");
    const dir = ensureAgentPlugin();
    const before = statSync(path.join(dir, ".fingerprint")).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    ensureAgentPlugin();
    expect(statSync(path.join(dir, ".fingerprint")).mtimeMs).toBe(before);
  });

  it("不在工作目录里：数据根下的插件目录，guard 看来是工作目录之外，Agent 改不到", async () => {
    const { ensureAgentPlugin } = await import("./plugin.js");
    const { judgeToolCall } = await import("./guard.js");
    const dir = ensureAgentPlugin();
    const ws = path.join(dataRoot, "clients", "c", "templates", "t");
    const d = judgeToolCall("Edit", { file_path: path.join(dir, "skills", "hypit", "SKILL.md") }, { workspace: ws });
    expect(d?.rule).toBe("write-outside-workspace");
  });

  it("找不到 hypit skill：报清楚是哪个路径，不静默铺一个空插件", async () => {
    process.env.CLONE_STUDIO_HYPIT_ROOT = path.join(dataRoot, "no-hypit-here");
    vi.resetModules();
    const { ensureAgentPlugin } = await import("./plugin.js");
    expect(() => ensureAgentPlugin()).toThrow(/找不到 hypit skill/);
  });
});
