import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexArgs, defaultKillTree, quotaMessage, runCodex } from "../src/codex-runner.js";

const FAKE = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
let root: string;
let log: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cs-runner-"));
  log = path.join(root, "calls.jsonl");
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

function run(mode: string, extra: { prompt?: string; images?: string[]; timeoutMs?: number; kills?: number[] } = {}) {
  return runCodex({
    command: process.execPath,
    prefixArgs: [FAKE],
    cwd: root,
    images: extra.images ?? [],
    prompt: extra.prompt ?? "$imagegen 画 ./images/codex-image.png",
    env: {
      ...process.env,
      FAKE_CODEX_MODE: mode,
      FAKE_CODEX_LOG: log,
      NODE_OPTIONS: "--no-warnings",
      CODEX_HOME: root,
    },
    ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
    ...(extra.kills
      ? {
          killTree: (pid: number) => {
            extra.kills?.push(pid);
            defaultKillTree(pid);
          },
        }
      : {}),
  });
}
const calls = () =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { argv: string[]; nodeOptions: string | null; references: string[] });

describe("codexArgs：REQ-011 的参数数组", () => {
  it("逐项：exec、忽略用户配置、JSONL、不落会话、沙箱、跳过 git 检查、-C、参考图、-- 之后是提示词", () => {
    const args = codexArgs({ cwd: "C:/work", images: ["C:/a.png", "C:/b.png"], prompt: "-p 画图" });
    const sandbox = process.platform === "win32" ? ["-c", 'windows.sandbox="elevated"'] : [];
    expect(args).toEqual([
      "exec",
      "--ignore-user-config",
      "--json",
      "--ephemeral",
      ...sandbox,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "C:/work",
      "--image",
      "C:/a.png",
      "--image",
      "C:/b.png",
      "--",
      "-p 画图",
    ]);
    expect(args.join(" ")).not.toMatch(/unelevated|danger-full-access|read-only/u);
  });

  it("参考图超过 4 张：拒", () => {
    expect(() => codexArgs({ cwd: "c", images: ["1", "2", "3", "4", "5"], prompt: "p" })).toThrow("最多 4 张");
    expect(
      codexArgs({ cwd: "c", images: ["1", "2", "3", "4"], prompt: "p" }).filter((a) => a === "--image"),
    ).toHaveLength(4);
  });
});

describe("runCodex：真起一个假 codex 子进程", () => {
  it("清掉 NODE_OPTIONS；提示词原样到达（shell: false，元字符不被解释）；拿到 thread_id 与 exit 0", async () => {
    const prompt = '$imagegen 画 ./images/codex-image.png & echo hacked > pwned.txt | "quoted" %PATH%';
    const out = await run("ok", { prompt });
    expect(out.exitCode).toBe(0);
    expect(out.events.threadId).toBe("019bd456-d3d4-70c3-90de-51d31a6c8571");
    expect(out.events.errors).toEqual([]);
    const [call] = calls();
    expect(call?.nodeOptions).toBe("");
    expect(call?.argv.at(-1)).toBe(prompt);
    expect(existsSync(path.join(root, "pwned.txt"))).toBe(false);
    expect(existsSync(path.join(root, "images", "codex-image.png"))).toBe(true);
  });

  it("参考图以 --image 传过去，文件内容就是写进去的那份", async () => {
    const ref = path.join(root, "reference-1.png");
    writeFileSync(ref, Buffer.from([1, 2, 3]));
    await run("ok", { images: [ref] });
    expect(calls()[0]?.references).toEqual(["010203"]);
  });

  it("error 事件与 turn.failed 进 errors；stderr 的额度原文认得出来", async () => {
    expect((await run("error")).events.errors).toEqual(["stream error: broken pipe"]);
    expect((await run("turnfailed")).events.errors).toEqual(["model response stream ended unexpectedly"]);
    const quota = await run("quota");
    expect(quota.exitCode).toBe(1);
    expect(quotaMessage(quota.stderr)).toContain("You've hit your usage limit");
    expect(quotaMessage((await run("ratelimit")).stderr)).toContain("rate limit exceeded");
    expect(quotaMessage("monthly quota exhausted")).toBe("monthly quota exhausted");
    expect(quotaMessage("all good")).toBeUndefined();
  });

  it("超时：杀进程树、标 timedOut，不会一直等", async () => {
    const kills: number[] = [];
    const started = Date.now();
    const out = await run("hang", { timeoutMs: 800, kills });
    expect(out.timedOut).toBe(true);
    expect(kills).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("一行超过 4 MB：停止读取、杀进程、记下原因", async () => {
    const kills: number[] = [];
    const out = await run("longline", { kills });
    expect(out.streamError).toContain("超过 4 MB");
    expect(kills).toHaveLength(1);
    expect(out.timedOut).toBe(false);
  });

  it("命令起不来：拒绝并说明", async () => {
    await expect(
      runCodex({
        command: path.join(root, "no-such-codex.exe"),
        prefixArgs: [],
        cwd: root,
        images: [],
        prompt: "p",
        env: {},
      }),
    ).rejects.toThrow("起不来 Codex");
  });
});

describe("runCodex：杀不掉也不永远挂着（11.1 审查 LOW-1）", () => {
  it("超时后 killTree 没杀掉进程：宽限期一过照样返回，标 timedOut", async () => {
    const pids: number[] = [];
    const started = Date.now();
    const out = await runCodex({
      command: process.execPath,
      prefixArgs: [FAKE],
      cwd: root,
      images: [],
      prompt: "$imagegen ./images/codex-image.png",
      env: { ...process.env, FAKE_CODEX_MODE: "hang", CODEX_HOME: root },
      timeoutMs: 300,
      killGraceMs: 500,
      killTree: (pid) => pids.push(pid), // 什么都不杀
    });
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
    // 收尾：同步杀掉这个假 codex（它还占着 cwd，Windows 上不死透删不掉目录）
    for (const pid of pids) {
      if (process.platform === "win32")
        execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
      else process.kill(pid, "SIGKILL");
    }
  });
});

describe("runCodex：codex 退了、孙进程占着管道（11.1 第二轮审查 LOW-A）", () => {
  it("超时后宽限期一过照样返回，不等孙进程", async () => {
    const pidFile = path.join(root, "grandchild.pid");
    const started = Date.now();
    const out = await runCodex({
      command: process.execPath,
      prefixArgs: [FAKE],
      cwd: root,
      images: [],
      prompt: "$imagegen ./images/codex-image.png",
      env: { ...process.env, FAKE_CODEX_MODE: "orphanpipe", FAKE_GRANDCHILD_PID: pidFile, CODEX_HOME: root },
      timeoutMs: 500,
      killGraceMs: 500,
    });
    expect(out.timedOut).toBe(true);
    expect(out.events.threadId).toBe("019bd456-d3d4-70c3-90de-51d31a6c8571");
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (process.platform === "win32") execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  });
});
