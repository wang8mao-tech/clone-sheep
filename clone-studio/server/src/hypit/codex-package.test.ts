import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Provider 包同步到数据根 node_modules（REQ-011；不用 --package-root 的理由见 codex-package.ts） */

let dataRoot: string;
let source: string;
const links: string[] = [];

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "cs-codexpkg-"));
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  source = path.join(dataRoot, "..", `${path.basename(dataRoot)}-src`);
  mkdirSync(path.join(source, "src"), { recursive: true });
  mkdirSync(path.join(source, "test"), { recursive: true });
  writeFileSync(path.join(source, "package.json"), '{"name":"@clone-studio/codex-image"}');
  writeFileSync(path.join(source, "src", "activation.ts"), "export default 1;");
  writeFileSync(path.join(source, "src", "provider.ts"), "export const p = 1;");
  writeFileSync(path.join(source, "src", "provider.test.ts"), "// test");
  writeFileSync(path.join(source, "test", "x.test.ts"), "// test");
  vi.resetModules();
});
afterEach(() => {
  // 链接只删链接本身，绝不递归进去
  for (const link of links.splice(0)) if (existsSync(link)) unlinkSync(link);
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

async function load() {
  return import("./codex-package.js");
}

describe("syncCodexPackage", () => {
  it("拷 package.json 与 src 里的非测试 .ts 到 <数据根>/node_modules/@clone-studio/codex-image", async () => {
    const { syncCodexPackage, installedCodexPackageDir } = await load();
    const r = syncCodexPackage(source);
    const dir = path.join(dataRoot, "node_modules", "@clone-studio", "codex-image");
    expect(installedCodexPackageDir()).toBe(dir);
    expect(r.written.sort()).toEqual(["package.json", "src/activation.ts", "src/provider.ts"]);
    expect(existsSync(path.join(dir, "src", "provider.test.ts"))).toBe(false);
    expect(existsSync(path.join(dir, "test"))).toBe(false);
  });

  it("内容没变不写；源码改了只写改的；目标里多出来的文件删掉", async () => {
    const { syncCodexPackage } = await load();
    syncCodexPackage(source);
    expect(syncCodexPackage(source)).toMatchObject({ written: [], removed: [] });
    writeFileSync(path.join(source, "src", "provider.ts"), "export const p = 2;");
    const dir = path.join(dataRoot, "node_modules", "@clone-studio", "codex-image");
    writeFileSync(path.join(dir, "src", "stale.ts"), "old");
    const r = syncCodexPackage(source);
    expect(r.written).toEqual(["src/provider.ts"]);
    expect(r.removed).toEqual(["src/stale.ts"]);
    expect(readFileSync(path.join(dir, "src", "provider.ts"), "utf8")).toBe("export const p = 2;");
  });

  it("路径上有链接（junction）：拒绝，不顺着写到数据根外面", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "cs-codexpkg-out-"));
    try {
      mkdirSync(path.join(dataRoot, "node_modules"), { recursive: true });
      const link = path.join(dataRoot, "node_modules", "@clone-studio");
      symlinkSync(outside, link, "junction");
      links.push(link);
      const { syncCodexPackage } = await load();
      expect(() => syncCodexPackage(source)).toThrow("是链接");
      expect(existsSync(path.join(outside, "codex-image"))).toBe(false);
    } finally {
      for (const link of links.splice(0)) if (existsSync(link)) unlinkSync(link);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("源码不在：说清楚", async () => {
    const { syncCodexPackage } = await load();
    expect(() => syncCodexPackage(path.join(source, "missing"))).toThrow("找不到 Codex Provider 源码");
  });

  it("默认源码路径就是仓库里的 providers/codex-image，且真能列出包文件", async () => {
    const { codexPackageFiles } = await load();
    const files = codexPackageFiles();
    expect(files).toContain("package.json");
    expect(files).toContain("src/activation.ts");
    expect(files).toContain("src/provider.ts");
    expect(files.some((f) => f.includes("test"))).toBe(false);
  });
});

describe("codexPackageProblem（11.2 审查 M1）", () => {
  it("没同步过：说不在；同步成功：null；再同步失败：带上失败原文，成功一次就清掉", async () => {
    const { codexPackageProblem, syncCodexPackage } = await load();
    expect(codexPackageProblem()).toBe("Provider 包不在数据根里（还没同步过）");
    syncCodexPackage(source);
    expect(codexPackageProblem()).toBeNull();
    expect(() => syncCodexPackage(path.join(source, "missing"))).toThrow();
    expect(codexPackageProblem()).toContain("Provider 包没同步上：找不到 Codex Provider 源码");
    syncCodexPackage(source);
    expect(codexPackageProblem()).toBeNull();
  });
});

describe("syncCodexPackage：链接与子目录（11.2 审查 L1～L3）", () => {
  it("目标目录里残留的链接（junction）：只删链接本身，不跟进去，同步照样成功", async () => {
    const { syncCodexPackage } = await load();
    syncCodexPackage(source);
    const outside = mkdtempSync(path.join(tmpdir(), "cs-codexpkg-out-"));
    try {
      writeFileSync(path.join(outside, "keep.txt"), "must survive");
      const link = path.join(dataRoot, "node_modules", "@clone-studio", "codex-image", "src", "stale-link");
      symlinkSync(outside, link, "junction");
      const r = syncCodexPackage(source);
      expect(r.removed).toEqual(["src/stale-link"]);
      expect(existsSync(link)).toBe(false);
      expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("must survive");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("路径上悬空的链接也认得出（lstat），拒绝", async () => {
    const gone = mkdtempSync(path.join(tmpdir(), "cs-codexpkg-gone-"));
    mkdirSync(path.join(dataRoot, "node_modules"), { recursive: true });
    const link = path.join(dataRoot, "node_modules", "@clone-studio");
    symlinkSync(gone, link, "junction");
    links.push(link);
    rmSync(gone, { recursive: true, force: true });
    const { syncCodexPackage } = await load();
    expect(() => syncCodexPackage(source)).toThrow("是链接");
  });

  it("src 里有子目录：直接报错，不悄悄漏拷", async () => {
    mkdirSync(path.join(source, "src", "nested"));
    writeFileSync(path.join(source, "src", "nested", "x.ts"), "export {};");
    const { syncCodexPackage } = await load();
    expect(() => syncCodexPackage(source)).toThrow("子目录");
  });
});

describe("syncCodexPackage：目标文件本身是链接（11.2 第二轮审查 L-b）", () => {
  it("悬空的文件链接：删掉链接再写，不顺着写到外面", async (t) => {
    const { syncCodexPackage } = await load();
    syncCodexPackage(source);
    const outside = path.join(tmpdir(), `cs-codexpkg-target-${Date.now()}.ts`);
    const to = path.join(dataRoot, "node_modules", "@clone-studio", "codex-image", "src", "provider.ts");
    rmSync(to);
    try {
      symlinkSync(outside, to, "file");
    } catch {
      // Windows 上建文件链接要管理员或开发者模式：建不了就没有这种局面，跳过
      t.skip();
      return;
    }
    try {
      syncCodexPackage(source);
      expect(existsSync(outside)).toBe(false);
      expect(readFileSync(to, "utf8")).toBe("export const p = 1;");
    } finally {
      rmSync(outside, { force: true });
    }
  });
});
