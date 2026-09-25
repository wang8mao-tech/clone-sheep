import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { which } from "../lib/which.js";
import type { CodexEndpoint } from "./runtime-profile.js";

/**
 * 本机 Codex CLI（REQ-011）：怎么起它、装没装、版本够不够、登没登录。
 *
 * 登录只看 `$CODEX_HOME/auth.json`（默认 `~/.codex`）在不在，**绝不读内容**——那是用户的订阅凭据。
 * 起 codex：npm 全局装的是 `.cmd` 垫片，`shell: false` 起不了（Node 20+ 为 CVE-2024-27980 禁了），
 * 解析出垫片指向的 `node_modules/@openai/codex/bin/codex.js`，用当前 node 起它；原生可执行文件直接起。
 */

export const CODEX_MIN_VERSION = "0.128.0";

export function codexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? path.resolve(raw) : path.join(homedir(), ".codex");
}

/** 找不到、或垫片指向的脚本不在：null */
export function resolveCodexCommand(find: typeof which = which): { command: string; prefixArgs: string[] } | null {
  const found = find("codex");
  if (!found) return null;
  if (!found.isBatch) return { command: found.path, prefixArgs: [] };
  const script = shimTarget(found.path);
  return script ? { command: process.execPath, prefixArgs: [script] } : null;
}

/**
 * npm 垫片里写的是 `"%dp0%\node_modules\@openai\codex\bin\codex.js"`：取出这个相对路径，
 * 换成垫片所在目录下的绝对路径。只认 `node_modules` 下的 `.js`，别的写法不猜。
 */
export function shimTarget(shimPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const match = /%~?dp0%?\\(node_modules\\[^"\r\n]+?\.js)"/iu.exec(text);
  if (!match?.[1]) return null;
  const script = path.join(path.dirname(shimPath), ...match[1].split("\\"));
  return existsSync(script) ? script : null;
}

/** `codex-cli 0.153.4` → `0.153.4` */
export function parseCodexVersion(stdout: string): string | null {
  return /(\d+\.\d+\.\d+)/u.exec(stdout)?.[1] ?? null;
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export interface CodexReadiness {
  ready: boolean;
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  /** 没准备好时的一句话原因 */
  problem: string | null;
  /** 可复制的修法 */
  fix: string | null;
}

function runVersion(cmd: { command: string; prefixArgs: string[] }): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd.command, [...cmd.prefixArgs, "--version"], {
      shell: false,
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

export async function codexReadiness(
  deps: {
    resolve?: typeof resolveCodexCommand;
    version?: (cmd: { command: string; prefixArgs: string[] }) => Promise<string | null>;
  } = {},
): Promise<CodexReadiness> {
  const cmd = (deps.resolve ?? resolveCodexCommand)();
  const loggedIn = existsSync(path.join(codexHome(), "auth.json"));
  if (!cmd) {
    return {
      ready: false,
      installed: false,
      version: null,
      loggedIn,
      problem: "不在 PATH",
      fix: "npm i -g @openai/codex",
    };
  }
  const stdout = await (deps.version ?? runVersion)(cmd);
  const version = stdout === null ? null : parseCodexVersion(stdout);
  if (!version) {
    return {
      ready: false,
      installed: true,
      version: null,
      loggedIn,
      problem: "读不出版本号",
      fix: "npm i -g @openai/codex",
    };
  }
  if (!versionAtLeast(version, CODEX_MIN_VERSION)) {
    return {
      ready: false,
      installed: true,
      version,
      loggedIn,
      problem: `版本 ${version} 低于 ${CODEX_MIN_VERSION}`,
      fix: "npm i -g @openai/codex@latest",
    };
  }
  if (!loggedIn) return { ready: false, installed: true, version, loggedIn, problem: "未登录", fix: "codex login" };
  return { ready: true, installed: true, version, loggedIn, problem: null, fix: null };
}

/** 写进 Runtime Profile 的 codex 起法；找不到 codex 就是 null（不绑，gpt-image 会明确报缺能力） */
export function codexEndpoint(resolve: typeof resolveCodexCommand = resolveCodexCommand): CodexEndpoint | null {
  const cmd = resolve();
  if (!cmd) return null;
  return process.env.CODEX_HOME?.trim() ? { ...cmd, codexHome: codexHome() } : cmd;
}
