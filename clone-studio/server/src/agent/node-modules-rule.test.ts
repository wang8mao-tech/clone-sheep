import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgeToolCall } from "./guard.js";

/**
 * Agent 不许造 node_modules（11.2 审查 H1 / 第二轮 MEDIUM-1）：hypit 从模板目录（最近的 package.json）往上找包，
 * 离得最近的优先。变体会话的工作目录是 productions/<id>/，要拦的范围得包括模板根；本地装包命令也会造出 node_modules。
 */

let template: string;
let variant: string;

beforeEach(() => {
  template = mkdtempSync(path.join(tmpdir(), "cs-nmrule-"));
  writeFileSync(path.join(template, "package.json"), "{}");
  variant = path.join(template, "productions", "p1");
  mkdirSync(variant, { recursive: true });
});
afterEach(() => rmSync(template, { recursive: true, force: true }));

const ctx = (workspace: string) => ({ workspace, pluginDir: "C:/plugin" });

describe("变体会话：模板根的 node_modules 也不许写", () => {
  it("Bash 从变体目录往上写 ../../node_modules：拦", () => {
    for (const command of [
      "mkdir -p ../../node_modules/@clone-studio/codex-image/src",
      "echo x > ../../node_modules/@clone-studio/codex-image/src/activation.ts",
      `cp -r evil "${path.join(template, "node_modules", "@clone-studio")}"`,
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx(variant))?.rule, command).toBe("protected-path");
    }
  });

  it("变体目录自己的 node_modules：Write 拦；变体目录里普通文件照常写", () => {
    expect(
      judgeToolCall("Write", { file_path: path.join(variant, "node_modules", "x.js"), content: "x" }, ctx(variant))
        ?.rule,
    ).toBe("protected-path");
    expect(
      judgeToolCall("Write", { file_path: path.join(variant, "SCRIPT.md"), content: "x" }, ctx(variant)),
    ).toBeUndefined();
  });
});

describe("本地装包命令也拦（会在工作目录里造 node_modules）", () => {
  it("npm / pnpm / yarn / bun 的 install、i、add、ci：拦；不装包的 npm 命令放行", () => {
    for (const command of [
      "npm install ./evil",
      "npm i evil",
      "pnpm add @clone-studio/codex-image",
      "yarn add x",
      "bun add x",
      "npm ci",
    ]) {
      const d = judgeToolCall("Bash", { command }, ctx(template));
      expect(d?.rule, command).toBe("protected-path");
      expect(d?.reason).toContain("node_modules");
    }
    for (const command of ["npm --version", "npm view sharp version", "echo npm install"]) {
      expect(judgeToolCall("Bash", { command }, ctx(template)), command).toBeUndefined();
    }
  });
});

describe("装包命令的其它写法（11.2 第三轮审查 L-1）", () => {
  it("子 shell、子命令前带选项、npx / corepack 前缀、.cmd 后缀：拦", () => {
    for (const command of [
      "(cd a; npm i)",
      "npm --prefix ../.. install ./evil",
      "pnpm -C ../.. add ./evil",
      "npx pnpm add ./evil",
      "corepack pnpm add ./evil",
      "npm.cmd install ./evil",
      "cd a && npm i foo",
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx(template))?.rule, command).toBe("protected-path");
    }
  });

  it("不装包的照常：npm run、npx 跑工具、pnpm --version、提到 install 的文字", () => {
    for (const command of [
      "npm run build",
      "npx hypit check a.svrun",
      "pnpm --version",
      'echo "npm install later"',
      "grep install README.md",
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx(template)), command).toBeUndefined();
    }
  });
});
