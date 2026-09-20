import { spawn } from "node:child_process";
import { config, paths } from "../config.js";
import { db } from "../db/index.js";
import { procs } from "../lib/procs.js";

/** hypit 的错误信封：`hypit.cli-error@1` */
export interface HypitCliError {
  format: "hypit.cli-error@1";
  ok: false;
  error: { code: string; message: string; help?: string };
}

export class HypitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly help?: string,
    /** 原始 stdout/stderr，界面要原样展示，不改写 */
    readonly raw?: string,
  ) {
    super(message);
    this.name = "HypitError";
  }
}

export interface HypitRunOptions {
  /** 工作目录。hypit 的相对路径都相对它解析。 */
  cwd: string;
  /** 记进 hypit_calls，方便按模板/出片单位翻调用历史 */
  subject?: { kind: string; id: string };
  /** stderr 是进度流，逐行回调 */
  onStderrLine?: (line: string) => void;
  /** 超时，默认 10 分钟；build 这种长命令由调用方放大 */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 注入子进程的环境变量（凭据走这里，不落盘到工作目录） */
  env?: Record<string, string>;
}

export interface HypitResult<T> {
  json: T;
  exitCode: number;
  stderr: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * 跑一条 hypit CLI 命令。
 *
 * 约定：永远带 --json，永远不 import hypit 的内部包（它们是 private 且无 semver 保证，
 * 见 Spec ASM-005）。stdout 是一份 JSON，stderr 是进度行。
 */
export async function runHypit<T = unknown>(
  args: readonly string[],
  options: HypitRunOptions,
): Promise<HypitResult<T>> {
  const started = Date.now();
  const argv = [paths.hypitCli, ...args];

  const child = spawn(process.execPath, argv, {
    cwd: options.cwd,
    // shell: false 是硬要求：参数里有用户可控的名称和路径，走 shell 会被注入
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      // Agent SDK 会设 NODE_OPTIONS，带进 hypit 子进程会让它加载不相干的 loader
      NODE_OPTIONS: "",
      ...options.env,
    },
  });
  procs.register(child, `hypit ${args[0] ?? ""}`, options.subject);

  let stdout = "";
  let stderr = "";
  let pending = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (!options.onStderrLine) return;
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) options.onStderrLine(trimmed);
    }
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  const onAbort = (): void => {
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  }).finally(() => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (pending.trim() && options.onStderrLine) options.onStderrLine(pending.trim());
  });

  const durationMs = Date.now() - started;
  const parsed = parseJsonTail(stdout);

  record({
    subject: options.subject,
    command: args[0] ?? "",
    args,
    cwd: options.cwd,
    exitCode,
    stdoutJson: parsed.ok ? JSON.stringify(parsed.value) : null,
    stderrText: stderr || null,
    durationMs,
  });

  if (timedOut) {
    throw new HypitError(
      "TIMEOUT",
      `hypit ${args.join(" ")} 超过 ${Math.round(timeoutMs / 1000)}s 未返回`,
      undefined,
      stderr,
    );
  }

  if (!parsed.ok) {
    throw new HypitError(
      "BAD_OUTPUT",
      exitCode === 0
        ? "hypit 返回了无法解析为 JSON 的输出"
        : `hypit 以退出码 ${exitCode} 结束，且没有给出可解析的 JSON`,
      undefined,
      // 原文全给出去：排障时这段往往是唯一线索
      `${stdout}\n${stderr}`.trim(),
    );
  }

  const value = parsed.value as Partial<HypitCliError>;
  if (value?.format === "hypit.cli-error@1") {
    const err = (value as HypitCliError).error;
    throw new HypitError(err.code, err.message, err.help, stderr || undefined);
  }

  return { json: parsed.value as T, exitCode, stderr, durationMs };
}

/**
 * hypit 偶尔会在 JSON 前面混进非 JSON 行（进度/警告串到 stdout）。
 * 从最后一个 `{` 起试着解析，取最长能解析成功的那段。
 */
function parseJsonTail(stdout: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // 继续找
  }
  const start = trimmed.indexOf("{");
  if (start < 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed.slice(start)) };
  } catch {
    return { ok: false };
  }
}

function record(row: {
  subject?: { kind: string; id: string };
  command: string;
  args: readonly string[];
  cwd: string;
  exitCode: number;
  stdoutJson: string | null;
  stderrText: string | null;
  durationMs: number;
}): void {
  try {
    db()
      .prepare(
        `INSERT INTO hypit_calls
           (subject_kind, subject_id, command, args, cwd, exit_code, stdout_json, stderr_text, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.subject?.kind ?? null,
        row.subject?.id ?? null,
        row.command,
        JSON.stringify(row.args),
        row.cwd,
        row.exitCode,
        row.stdoutJson,
        row.stderrText,
        row.durationMs,
        new Date().toISOString(),
      );
  } catch {
    // 留痕失败不该让业务调用失败
  }
}

/** `hypit doctor --json` 的形状（Phase 0 实测） */
export interface HypitDoctor {
  format: "hypit.cli-doctor@1";
  ok: boolean;
  project: string;
  profileSource: string;
  diagnosticCount: number;
  diagnostics: Array<{ severity: string; code: string; message: string; subject?: string }>;
}

export async function doctor(
  cwd: string,
  extraArgs: readonly string[] = [],
  env?: Record<string, string>,
): Promise<HypitDoctor> {
  const { json } = await runHypit<HypitDoctor>(["doctor", ...extraArgs, "--json"], {
    cwd,
    timeoutMs: 120_000,
    ...(env ? { env } : {}),
  });
  return json;
}

export async function version(): Promise<string> {
  const child = spawn(process.execPath, [paths.hypitCli, "--version"], {
    cwd: config.repoRoot,
    shell: false,
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  procs.register(child, "hypit --version");
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    out += c;
  });
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  return out.trim();
}
