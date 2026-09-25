import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateImage } from "../src/locate-image.js";

let root: string;
let cwd: string;
let home: string;
const thread = "019bd456-d3d4";
const now = Date.now();
const base = () => ({
  cwd,
  name: "codex-image",
  codexHome: home,
  threadId: thread,
  startedAt: now - 60_000,
  endedAt: now,
});

function generated(name: string, content: string, mtimeMs: number): string {
  const dir = path.join(home, "generated_images", thread);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, content);
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cs-locate-"));
  cwd = path.join(root, "work");
  home = path.join(root, "home");
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("locateImage：两条路互为兜底（REQ-011）", () => {
  it("./images/<name>.png 在就用它，不看 generated_images", () => {
    mkdirSync(path.join(cwd, "images"));
    writeFileSync(path.join(cwd, "images", "codex-image.png"), "png");
    generated("a.png", "other", now - 1000);
    expect(locateImage(base())).toEqual({ file: path.join(cwd, "images", "codex-image.png"), via: "images" });
  });

  it("没复制过来：取 generated_images/<thread>/ 里运行区间内最新的 PNG", () => {
    // 旧的按文件名排在前面：只取第一个的实现会拿错
    generated("a-old.png", "x", now - 50_000);
    const newest = generated("b-new.png", "y", now - 10_000);
    generated("note.txt", "z", now - 5_000);
    expect(locateImage(base())).toEqual({ file: newest, via: "generated_images" });
  });

  it("区间外的旧图、空文件都不算；空的 ./images 文件也不算", () => {
    mkdirSync(path.join(cwd, "images"));
    writeFileSync(path.join(cwd, "images", "codex-image.png"), "");
    generated("before.png", "x", now - 10 * 60_000);
    generated("empty.png", "", now - 10_000);
    expect(locateImage(base())).toBeUndefined();
  });

  it("没有 thread_id、或 thread_id 带路径字符：不去 generated_images 找", () => {
    generated("new.png", "y", now - 10_000);
    expect(locateImage({ ...base(), threadId: undefined })).toBeUndefined();
    // `..` 跳出 generated_images 的那个位置真放一张图：不校验就会被拿走
    mkdirSync(path.join(home, thread), { recursive: true });
    writeFileSync(path.join(home, thread, "escaped.png"), "z");
    expect(locateImage({ ...base(), threadId: `../${thread}` })).toBeUndefined();
  });

  it("什么都没有：undefined", () => {
    expect(locateImage(base())).toBeUndefined();
  });
});
