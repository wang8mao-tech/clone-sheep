import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 工作目录里的 node_modules 盖掉宿主同步的 Provider 包（11.2 审查 H1，已实测复现）：hypit 找包时离工作目录
 * 最近的 node_modules 优先，Agent 在工作目录里写一份同名包，宿主带着凭据环境跑 hypit 时就执行了它。
 * 宿主每次调 hypit 前查一遍，查到就拒绝调用。
 */

let dataRoot: string;
let workspace: string;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "cs-shadow-"));
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  workspace = path.join(dataRoot, "clients", "c1", "templates", "t1");
  mkdirSync(path.join(workspace, "productions", "p1"), { recursive: true });
  vi.resetModules();
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

function shadow(dir: string): string {
  const pkg = path.join(dir, "node_modules", "@clone-studio", "codex-image");
  mkdirSync(path.join(pkg, "src"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), '{"name":"@clone-studio/codex-image"}');
  return path.join(dir, "node_modules", "@clone-studio");
}

describe("findShadowPackages", () => {
  it("干净的工作目录：没有", async () => {
    const { findShadowPackages } = await import("./shadow-packages.js");
    expect(findShadowPackages(workspace)).toEqual([]);
  });

  it("工作目录里、变体子目录里、客户与模板的上级目录里写了 node_modules/@clone-studio：都查得到", async () => {
    const { findShadowPackages } = await import("./shadow-packages.js");
    const inWorkspace = shadow(workspace);
    expect(findShadowPackages(workspace)).toEqual([inWorkspace]);
    const inProduction = shadow(path.join(workspace, "productions", "p1"));
    const inClients = shadow(path.join(dataRoot, "clients"));
    expect(findShadowPackages(path.join(workspace, "productions", "p1")).sort()).toEqual(
      [inProduction, inWorkspace, inClients].sort(),
    );
  });

  it("数据根自己的 node_modules 是宿主同步的那份：不算", async () => {
    const { findShadowPackages } = await import("./shadow-packages.js");
    shadow(dataRoot);
    expect(findShadowPackages(workspace)).toEqual([]);
  });

  it("不在数据根下的目录（体检、宿主自己的临时工程之外）：不查", async () => {
    const { findShadowPackages } = await import("./shadow-packages.js");
    const outside = mkdtempSync(path.join(tmpdir(), "cs-shadow-out-"));
    try {
      shadow(outside);
      expect(findShadowPackages(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("runHypit：查到就不起 hypit", () => {
  it("拒绝，错误码 SHADOW_PACKAGE，原文写出位置；子进程根本没起", async () => {
    shadow(workspace);
    const spawned = vi.fn();
    vi.doMock("node:child_process", async (original) => ({
      ...(await original<typeof import("node:child_process")>()),
      spawn: (...args: unknown[]) => {
        spawned(args);
        throw new Error("不该起子进程");
      },
    }));
    const { runHypit, HypitError } = await import("./cli.js");
    const err = await runHypit(["plan", "reference.svrun", "--json"], { cwd: workspace }).catch((e: unknown) => e);
    vi.doUnmock("node:child_process");
    expect(err).toBeInstanceOf(HypitError);
    expect((err as InstanceType<typeof HypitError>).code).toBe("SHADOW_PACKAGE");
    expect((err as Error).message).toContain(path.join(workspace, "node_modules", "@clone-studio"));
    expect(spawned).not.toHaveBeenCalled();
  });
});

describe("runHypit：--workspace 指的目录也查（11.2 第二轮审查 L-c）", () => {
  it("cwd 在数据根外、--workspace 指向有覆盖包的工程：照样拒", async () => {
    shadow(workspace);
    const outside = mkdtempSync(path.join(tmpdir(), "cs-shadow-cwd-"));
    try {
      const { runHypit } = await import("./cli.js");
      const err = await runHypit(["plan", "x.svrun", "--workspace", workspace, "--json"], { cwd: outside }).catch(
        (e: unknown) => e,
      );
      expect((err as { code?: string }).code).toBe("SHADOW_PACKAGE");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
