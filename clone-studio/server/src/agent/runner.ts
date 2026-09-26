import { spawn } from "node:child_process";
import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { config, paths } from "../config.js";
import { AGENT_LABEL, procs, type ProcSubject } from "../lib/procs.js";
import { ensureHypitBin } from "./hypit-bin.js";
import { ensureAgentPlugin } from "./plugin.js";
import { buildSessionOptions, type SessionInput } from "./session.js";

/**
 * 跑一次 Agent 会话（Spec REQ-003）：开会话 → 流式把每条消息交给调用方 → 返回会话 id 与
 * 最后一条 result。熔断、排队、限流等待在调度层（scheduler.ts），消息落库与 SSE 在
 * Task 5.3——它们都通过 onMessage / onIntercept / stopSignal 接进来，这里不认识数据库。
 *
 * **怎么停**（Task 5.2 复审实测，scripts/spike-interrupt-cost.mjs）：
 * - 用流式输入模式，停的时候调 `interrupt()`：立刻收到一条带 total_cost_usd 的 result，
 *   Bash 起的子进程也被带走，1 秒后工作目录就能删。
 * - 不用 AbortController 直接掐：掐完要 7 秒才抛、拿不到 result（这次运行的花费就丢了），
 *   而且子进程活到自己结束，一直攥着工作目录——删模板时「进程已结束再删目录」不成立。
 * - interrupt 10 秒还没回 result：兜底硬停，并连子孙一起强杀 Claude Code 进程。
 * - 会话还没起来（没收到 init）就要停的：没有会话可保、也没有花费可捞，直接硬停，
 *   不为一个可能没人应答的 interrupt 等满 10 秒。
 *
 * 返回不代表进程一定已经退干净：兜底强杀是发出去就返回的，正常结束时 Claude Code 自己收完
 * 后台命令也要几秒（实测约 5 秒内收干净）。要"进程已结束再删目录"（AC-002）的地方，按 procs
 * 的 killBySubject 再确认一次：那时父进程还在登记表里，按树杀能连子孙一起带走。
 *
 * Claude Code 进程由这里自己 spawn（SDK 的 spawnClaudeCodeProcess），登记进 procs：
 * 后端退出时统一收尸，删对象时也能按 subject 找到它。
 */

export const STOP_GRACE_MS = 10_000;
/** 进程起不来时报错带上的 stderr 尾巴长度 */
const STDERR_TAIL = 2_000;

export interface RunInput extends Omit<SessionInput, "pluginDir" | "abortController" | "spawnClaudeCodeProcess"> {
  prompt: string;
  onMessage: (message: SDKMessage) => void;
  /** 宿主要停这次运行（中止、取消、熔断）：触发后先 interrupt，拿到带花费的 result 再结束 */
  stopSignal?: AbortSignal;
  /** Claude Code 进程登记在谁名下：删对象时按它收尸 */
  subject?: ProcSubject;
}

export interface RunOutcome {
  /** 会话 id，供继续 / 打回 resume；会话没起来时为空 */
  sessionId?: string;
  /**
   * 最后一条 result 消息。读花费只取它的 total_cost_usd，不跨 result 累加：resume 的会话
   * 会续上转录里保存的累计值（Phase 0 实测 0.0518 > 0.0479）
   */
  result?: SDKResultMessage;
  /** 会话在拿到 result 之前就抛了（进程起不来、网络断、兜底硬停） */
  error?: string;
  /** 是宿主要停的（中止 / 取消 / 熔断），不是自己出的错。调度层按自己的动作与熔断结论定状态，这里只作诊断 */
  aborted?: boolean;
  /**
   * 调用方自己的 onMessage 抛了（例如落库失败）。和 SDK 的错误分开报：否则最后一条
   * 消息没存进去也会被当成「以 result 为准」而悄悄吞掉（复审）
   */
  callbackError?: string;
}

export async function runAgent(input: RunInput): Promise<RunOutcome> {
  const { prompt, onMessage, stopSignal, subject, ...session } = input;
  const outcome: RunOutcome = {};
  const hard = new AbortController();
  let stderrTail = "";
  // SDK 万一重开传输就会有第二个进程：全都记下来，停的时候一个都不漏
  const pids = new Set<number>();
  let q: Query | undefined;
  let graceTimer: NodeJS.Timeout | undefined;

  // 流式输入：只发一条任务消息，输入流撑到第一条 result 为止——关掉输入就等于结束会话
  let release: () => void = () => {};
  const inputDone = new Promise<void>((resolve) => (release = resolve));
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" };
    await inputDone;
  }

  const spawnClaudeCode = (o: SpawnOptions) => {
    const child = spawn(o.command, o.args, {
      cwd: o.cwd,
      env: o.env,
      // 用 SDK 转发的 signal，不是我们的 hard：它只在 stdin 关闭 + 约 2 秒宽限之后才触发，
      // 所以 hardStop 里 abort 之后父进程还活着，taskkill /T 才枚举得到子孙
      signal: o.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    procs.register(child, AGENT_LABEL, subject);
    if (child.pid !== undefined) pids.add(child.pid);
    return child;
  };

  const hardStop = () => {
    hard.abort();
    release();
    for (const pid of pids) void procs.killTree(pid);
  };

  const stop = () => {
    // 会话还没起来就停：interrupt 是走 stdin 的控制请求，这时候可能没人应答，
    // 干等 10 秒只会把删除对话框一起拖住；反正没有会话和花费要保
    if (outcome.sessionId === undefined) {
      hardStop();
      return;
    }
    q?.interrupt().catch(() => undefined);
    graceTimer = setTimeout(hardStop, STOP_GRACE_MS);
  };

  try {
    const options = buildSessionOptions({
      ...session,
      pluginDir: ensureAgentPlugin(),
      binDir: ensureHypitBin(),
      secretsFile: paths.secrets,
      hypitRoot: config.hypitRoot,
      abortController: hard,
      spawnClaudeCodeProcess: spawnClaudeCode,
    });
    q = query({ prompt: messages(), options });
    if (stopSignal?.aborted) stop();
    else stopSignal?.addEventListener("abort", stop, { once: true });

    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") outcome.sessionId = message.session_id;
      if (message.type === "result") outcome.result = message;
      try {
        onMessage(message);
      } catch (error) {
        // 记下第一处就够：之后的消息照常往下交，别因为一条没存进去就把会话掐掉
        outcome.callbackError ??= error instanceof Error ? error.message : String(error);
      }
      if (message.type === "result") break;
    }
  } catch (error) {
    // 已经拿到 result 的，以 result 为准，不再当成进程故障
    if (!outcome.result) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.error = stderrTail.trim() ? `${message}\n${stderrTail.trim()}` : message;
    }
  } finally {
    clearTimeout(graceTimer);
    stopSignal?.removeEventListener("abort", stop);
    release();
    q?.close();
  }
  if (stopSignal?.aborted) outcome.aborted = true;
  return outcome;
}
