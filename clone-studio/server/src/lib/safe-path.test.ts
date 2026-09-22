import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInside, isReallyInside } from "./safe-path.js";

describe("isInside", () => {
  const root = path.resolve("/data/root");

  it("子路径与根本身算在里面", () => {
    expect(isInside(root, path.join(root, "a", "b.mp4"))).toBe(true);
    expect(isInside(root, root)).toBe(true);
  });

  it("上级与兄弟目录不算", () => {
    expect(isInside(root, path.resolve("/data"))).toBe(false);
    expect(isInside(root, path.resolve("/data/root2/x"))).toBe(false);
    expect(isInside(root, path.join(root, "..", "x"))).toBe(false);
  });

  it("名字以 .. 开头的子目录不被误伤（旧写法 startsWith('..') 会拒）", () => {
    expect(isInside(root, path.join(root, "..cache", "x"))).toBe(true);
  });
});

describe("isReallyInside", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "cs-safe-path-"));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "x");
  });

  afterEach(() => {
    const link = path.join(root, "link");
    if (existsSync(link)) rmdirSync(link);
    rmSync(base, { recursive: true, force: true });
  });

  it("普通文件：在里面", () => {
    writeFileSync(path.join(root, "a.mp4"), "x");
    expect(isReallyInside(root, path.join(root, "a.mp4"))).toBe(true);
  });

  it("经 junction 指到外面：字面在里面，真实路径不在，判不在", () => {
    symlinkSync(outside, path.join(root, "link"), "junction");
    const target = path.join(root, "link", "secret.txt");
    expect(isInside(root, target)).toBe(true);
    expect(isReallyInside(root, target)).toBe(false);
  });

  it("目标还不存在：退回字面判断", () => {
    expect(isReallyInside(root, path.join(root, "later.mp4"))).toBe(true);
    expect(isReallyInside(root, path.join(outside, "later.mp4"))).toBe(false);
  });
});
