import { spawn } from "node:child_process";
import { emptyEvents, LineSplitter, LineTooLongError, readEvent, type CodexEvents } from "./jsonl.js";

/**
 * 起一次 `codex exec`（REQ-011）：一图一进程，绝不批量。
 *
 * - `shell: false`：参数里有作者写的提示词，走 shell 会被注入
 * - 清掉 `NODE_OPTIONS`：宿主（hypit Worker / Agent SDK）会设它，带进 codex 的 node 会加载不相干的 loader
 * - Windows 上沙箱用 `elevated`；不用 `unelevated` 或 `danger-full-access`
 * - `--sandbox workspace-write` 不能收紧到禁命令：Codex 靠一条复制命令把图搬进 ./images
 *
 * `command` + `prefixArgs`：npm 装的 codex 在 Windows 上是 `.cmd` 垫片，`shell: false` 起不了，
 * 宿主解析出 `codex.js` 后这里是 `node` + `[codex.js]`；原生可执行文件就是它自己 + `[]`。
 */

export const MAX_REFERENCES = 4;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface CodexCommand {
  command: string;
  prefixArgs: readonly string[];
}

export function codexArgs(options: { cwd: string; images: readonly string[]; prompt: string }): string[] {
  if (options.images.length > MAX_REFERENCES) throw new Error(`参考图最多 ${MAX_REFERENCES} 张`);
  const args = ["exec", "--ignore-user-config", "--json", "--ephemeral"];
  if (process.platform === "win32") args.push("-c", 'windows.sandbox="elevated"');
  args.push("--sandbox", "workspace-write", "--skip-git-repo-check", "-C", options.cwd);
  for (const image of options.images) args.push("--image", image);
  // `--` 之后是提示词：提示词以 - 开头时不会被当成选项
  args.push("--", options.prompt);
  return args;
}

export interface CodexRun {
  exitCode: number | null;
  events: CodexEvents;
  stderr: string;
  startedAt: number;
  endedAt: number;
  timedOut: boolean;
  /** 读 stdout 本身出的错（单行超长） */
  streamError: string | undefined;
}

export interface RunCodexOptions extends CodexCommand {
  cwd: string;
  images: readonly string[];
  prompt: string;
  /** codex 的环境：CODEX_HOME 等。NODE_OPTIONS 一律清掉 */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** 杀进程树；测试替换，生产按平台 */
  killTree?: (pid: number) => void;
  /**
   * 杀了之后最多再等多久（11.1 审查 LOW-1）：沙箱里的进程可能杀不掉，或孙进程还占着 stdout 管道，
   * `close` 就永远不来——宽限期一过不再等，直接带着已有的输出返回
   */
  killGraceMs?: number;
}

export const DEFAULT_KILL_GRACE_MS = 15_000;

/** stderr 只留尾巴：够看出配额 / 限流原文，又不让一次异常把内存吃满 */
const STDERR_KEEP = 64 * 1024;

export function defaultKillTree(pid: number): void {
  if (process.platform === "win32") {
    // 异步起 taskkill、不等它：Codex 会拉起沙箱子进程，只杀父进程会留下孤儿
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { shell: false, windowsHide: true, stdio: "ignore" }).on(
      "error",
      () => {
        /* 进程已经没了 */
      },
    );
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 进程已经没了 */
  }
}

export function runCodex(options: RunCodexOptions): Promise<CodexRun> {
  const args = [...options.prefixArgs, ...codexArgs(options)];
  const env: NodeJS.ProcessEnv = { ...options.env, NODE_OPTIONS: "" };
  const startedAt = Date.now();
  const events = emptyEvents();
  const splitter = new LineSplitter();
  const killTree = options.killTree ?? defaultKillTree;
  let stderr = "";
  let timedOut = false;
  let streamError: string | undefined;

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, args, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // .cmd 配 shell:false 之类是同步抛的（审查实测 EINVAL），和异步的 error 事件一样说清楚
      reject(new Error(`起不来 Codex：${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let grace: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (streamError === undefined) for (const line of splitter.end()) readEvent(events, line);
      resolve({ exitCode, events, stderr, startedAt, endedAt: Date.now(), timedOut, streamError });
    };
    const stop = () => {
      if (grace) return;
      // 只有杀进程这一步看 codex 还在不在；它已经退了、孙进程还占着管道时照样要起宽限计时（第二轮审查 LOW-A）
      if (child.pid !== undefined && child.exitCode === null) killTree(child.pid);
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(child.exitCode);
      }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (streamError !== undefined) return;
      try {
        for (const line of splitter.push(chunk)) readEvent(events, line);
      } catch (error) {
        streamError = error instanceof LineTooLongError ? error.message : String(error);
        stop();
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      reject(new Error(`起不来 Codex：${error.message}`));
    });
    child.on("close", (code) => settle(code));
  });
}

/**
 * stderr 里的配额 / 限流原文（REQ-011：失败，原文进 Build 错误，由「重试出片」接续）。
 * Codex 订阅额度用完的原话是「You've hit your usage limit…」，不含 rate limit / quota，一并认（11.1 审查）
 */
export function quotaMessage(stderr: string): string | undefined {
  const line = stderr.split(/\r?\n/u).find((l) => /rate limit|quota|usage limit/iu.test(l));
  return line?.trim() || undefined;
}
