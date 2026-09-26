import { HypitError, runHypit, type HypitRunOptions } from "./cli.js";

/**
 * 本地 WhisperX 服务（REQ-002 MUST：转写走 provider-whisperx-local）的端点约定。
 *
 * 工作目录的 hypit.runtime.json 由 workspace.ts 生成，端点 id 与配置都是我们
 * 写死的：`whisperx.local`、`config: {}`，于是服务地址就是 provider 的默认值
 * `http://127.0.0.1:8765`（provider-whisperx-local/src/provider.ts）。体检与
 * 流水线都从这里取，不各猜一份。
 */
export const WHISPERX_ENDPOINT_ID = "whisperx.local";
export const WHISPERX_HOST = "127.0.0.1";
export const WHISPERX_PORT = 8765;
const WHISPERX_PROTOCOL = "hypit.whisperx-service@1";

/**
 * hypit 给这个端点建的程序目录名（provider-whisperx-local/src/program.ts：
 * `whisperx-${encodeURIComponent(id)}-${encodeURIComponent(host)}`）。
 */
export const WHISPERX_PROGRAM_DIR = `whisperx-${encodeURIComponent(WHISPERX_ENDPOINT_ID)}-${encodeURIComponent(
  `${WHISPERX_HOST}:${WHISPERX_PORT}`,
)}`;

/**
 * - up：是我们的服务且自报健康
 * - down：端口没人监听
 * - foreign：有东西在听，但不是 WhisperX 服务、或者它说自己不健康、或者卡住不回
 *
 * 只连 TCP 不够：别的程序占着 8765、服务卡死时端口照样能连上，体检会报绿，
 * 流水线也会跳过拉起，转写再报一句看不懂的错（复审第二轮 M1）。所以问 /health，
 * 按 hypit 自己的探针核对 ok 与 protocol（provider-whisperx-local/src/program.ts）。
 */
export type WhisperXProbe = "up" | "down" | "foreign";

/** 超时与 hypit 自己的探针一致（2 秒）：CPU 推理吃满时 /health 可能慢一点，别误报占用 */
export async function probeWhisperX(timeoutMs = 2000, port = WHISPERX_PORT): Promise<WhisperXProbe> {
  let res: Response;
  try {
    res = await fetch(`http://${WHISPERX_HOST}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // 只有「连接被拒」能证明没人在听。连接被重置、回的不是 HTTP、超时不回，都说明
    // 端口上有东西但不是健康的 WhisperX（复审第三轮实测 ECONNRESET / HTTPParserError）
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return code === "ECONNREFUSED" || code === "EADDRNOTAVAIL" ? "down" : "foreign";
  }
  try {
    const body = (await res.json()) as { ok?: unknown; protocol?: unknown };
    return res.ok && body.ok === true && body.protocol === WHISPERX_PROTOCOL ? "up" : "foreign";
  } catch {
    return "foreign";
  }
}

export const PORT_TAKEN_MESSAGE =
  `${WHISPERX_HOST}:${WHISPERX_PORT} 上有程序在监听，但不是健康的 WhisperX 服务` +
  "（被别的程序占用，或服务卡住了）。关掉占用端口的程序或重启服务后重试。";

interface ProgramsUpResult {
  ok?: boolean;
  ready?: boolean;
  programs?: { id?: string; state?: string; stateDetail?: string; detail?: string; logPath?: string }[];
}

/**
 * 转写前确保服务在跑。
 *
 * hypit 不会自己拉起托管程序（runtime-local 注明 programs up 是显式步骤，plan / build
 * 从不调），服务停着时 transcribe 两秒就失败，报错只有一句 `fetch failed`，看不出
 * 原因。重启电脑后必然如此（实测）。
 *
 * 先探健康，好的直接返回：`programs up` 即便服务已在跑也要 18 秒左右（实测），
 * 不能每次都调。没在跑才调，冷启动实测 78 秒到 3 分钟，由调用方从单步超时里分配预算。
 *
 * **programs up 起不来时不会抛错**：它正常输出 `ok:false, ready:false` 并以退出码 1
 * 结束（另一个 up 占着锁、安装失败、等不到就绪……），runHypit 不看退出码。所以必须
 * 自己核对 ok 与 ready，否则会当成已拉起，转写照样报 fetch failed（复审第二轮 H1）。
 */
export async function ensureWhisperX(
  workspace: string,
  options: Omit<HypitRunOptions, "cwd">,
  hooks: { probe?: () => Promise<WhisperXProbe>; onStarting?: () => void } = {},
): Promise<"already-up" | "started"> {
  const before = await (hooks.probe ?? (() => probeWhisperX()))();
  if (before === "up") return "already-up";
  if (before === "foreign") throw new HypitError("WHISPERX_PORT_TAKEN", PORT_TAKEN_MESSAGE);
  // 拉起要一两分钟，让界面知道在等什么，而不是一直显示「转写中」
  hooks.onStarting?.();

  const result = await runHypit<ProgramsUpResult>(
    ["programs", "up", "--endpoint", WHISPERX_ENDPOINT_ID, "--workspace", workspace, "--json"],
    { ...options, cwd: workspace },
  );
  if (result.json.ok !== true || result.json.ready !== true) {
    const lines = (result.json.programs ?? []).map((p) =>
      [p.id, p.state, p.stateDetail, p.detail, p.logPath ? `日志 ${p.logPath}` : undefined].filter(Boolean).join(" · "),
    );
    throw new HypitError(
      "WHISPERX_NOT_READY",
      `本地转写服务没能启动：${lines.join("；") || `programs up 退出码 ${result.exitCode}`}`,
      undefined,
      JSON.stringify(result.json, null, 2),
    );
  }
  return "started";
}
