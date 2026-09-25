import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexEndpoint,
  codexHome,
  codexReadiness,
  parseCodexVersion,
  resolveCodexCommand,
  shimTarget,
  versionAtLeast,
} from "./codex.js";

/** 本机 Codex CLI（REQ-011）：怎么起、版本、登录只看 auth.json 在不在 */

let root: string;
const savedHome = process.env.CODEX_HOME;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cs-codexcli-"));
  delete process.env.CODEX_HOME;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** npm 全局安装在 Windows 上写出的 codex.cmd 原样（本机 %APPDATA%\npm\codex.cmd 的尾部） */
function npmShim(dir: string, withScript = true): string {
  const shim = path.join(dir, "codex.cmd");
  writeFileSync(
    shim,
    [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      "",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      "",
    ].join("\r\n"),
  );
  if (withScript) {
    const bin = path.join(dir, "node_modules", "@openai", "codex", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "codex.js"), "// codex");
  }
  return shim;
}

describe("shimTarget / resolveCodexCommand：.cmd 垫片解析成 node + codex.js", () => {
  it("npm 垫片：取出 node_modules 下的 codex.js 绝对路径", () => {
    const shim = npmShim(root);
    expect(shimTarget(shim)).toBe(path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js"));
  });

  it("脚本不在、垫片读不到、写法不认识：null（不猜）", () => {
    expect(shimTarget(npmShim(root, false))).toBeNull();
    expect(shimTarget(path.join(root, "nope.cmd"))).toBeNull();
    const odd = path.join(root, "odd.cmd");
    writeFileSync(odd, '@echo off\r\n"C:\\tools\\codex.exe" %*\r\n');
    expect(shimTarget(odd)).toBeNull();
  });

  it("垫片 → 当前 node + [codex.js]；原生 exe → 它自己 + []；找不到 → null", () => {
    const shim = npmShim(root);
    expect(resolveCodexCommand(() => ({ path: shim, isBatch: true }))).toEqual({
      command: process.execPath,
      prefixArgs: [path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js")],
    });
    expect(resolveCodexCommand(() => ({ path: "C:/codex/codex.exe", isBatch: false }))).toEqual({
      command: "C:/codex/codex.exe",
      prefixArgs: [],
    });
    expect(resolveCodexCommand(() => null)).toBeNull();
    const bare = path.join(root, "bare");
    mkdirSync(bare);
    expect(resolveCodexCommand(() => ({ path: npmShim(bare, false), isBatch: true }))).toBeNull();
  });
});

describe("版本号", () => {
  it("从 --version 输出取版本；比较按三段数字", () => {
    expect(parseCodexVersion("codex-cli 0.153.4\n")).toBe("0.153.4");
    expect(parseCodexVersion("garbage")).toBeNull();
    expect(versionAtLeast("0.153.4", "0.128.0")).toBe(true);
    expect(versionAtLeast("0.128.0", "0.128.0")).toBe(true);
    expect(versionAtLeast("0.127.99", "0.128.0")).toBe(false);
    expect(versionAtLeast("1.0.0", "0.128.0")).toBe(true);
    expect(versionAtLeast("0.99.0", "0.128.0")).toBe(false);
  });
});

describe("codexReadiness（AC-033）", () => {
  const found = () => ({ command: "node", prefixArgs: ["codex.js"] });
  const version = (v: string | null) => async () => v;

  it("不在 PATH：没准备好，给安装命令", async () => {
    const r = await codexReadiness({ resolve: () => null });
    expect(r).toMatchObject({ ready: false, installed: false, problem: "不在 PATH", fix: "npm i -g @openai/codex" });
  });

  it("版本低于 0.128：没准备好，给升级命令；读不出版本也不算好", async () => {
    process.env.CODEX_HOME = root;
    writeFileSync(path.join(root, "auth.json"), "{}");
    expect(await codexReadiness({ resolve: found, version: version("codex-cli 0.127.0") })).toMatchObject({
      ready: false,
      version: "0.127.0",
      fix: "npm i -g @openai/codex@latest",
    });
    expect(await codexReadiness({ resolve: found, version: version(null) })).toMatchObject({
      ready: false,
      installed: true,
    });
  });

  it("CODEX_HOME 指向空目录（没有 auth.json）：未登录，提示 codex login", async () => {
    process.env.CODEX_HOME = root;
    const r = await codexReadiness({ resolve: found, version: version("codex-cli 0.153.4") });
    expect(r).toMatchObject({
      ready: false,
      loggedIn: false,
      problem: "未登录",
      fix: "codex login",
      version: "0.153.4",
    });
  });

  it("CODEX_HOME 里有 auth.json 且版本够：准备好了", async () => {
    process.env.CODEX_HOME = root;
    writeFileSync(path.join(root, "auth.json"), "{}");
    const r = await codexReadiness({ resolve: found, version: version("codex-cli 0.153.4") });
    expect(r).toEqual({ ready: true, installed: true, version: "0.153.4", loggedIn: true, problem: null, fix: null });
  });
});

describe("codexHome / codexEndpoint", () => {
  it("没设 CODEX_HOME：~/.codex，profile 里不写 codexHome（Provider 自己用默认）", () => {
    expect(codexHome().endsWith(`${path.sep}.codex`)).toBe(true);
    expect(codexEndpoint(() => ({ command: "node", prefixArgs: ["c.js"] }))).toEqual({
      command: "node",
      prefixArgs: ["c.js"],
    });
  });

  it("设了 CODEX_HOME：profile 里写上它的绝对路径；找不到 codex 就是 null", () => {
    process.env.CODEX_HOME = root;
    expect(codexEndpoint(() => ({ command: "node", prefixArgs: [] }))).toEqual({
      command: "node",
      prefixArgs: [],
      codexHome: path.resolve(root),
    });
    expect(codexEndpoint(() => null)).toBeNull();
  });
});
