import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { config, paths } from "../config.js";
import { ensureHypitBin } from "./hypit-bin.js";
import { ensureAgentPlugin } from "./plugin.js";
import { buildSessionOptions, type SessionInput } from "./session.js";

/**
 * 跑一次 Agent 会话（Spec REQ-003）：开会话 → 流式把每条消息交给调用方 → 返回会话 id 与
 * 最后一条 result。
 *
 * 只管会话本身的生命周期。熔断、排队、限流等待在调度层（Task 5.2），消息落库与 SSE 在
 * Task 5.3——它们都通过 onMessage / onIntercept 接进来，这里不认识数据库。
 */

export interface RunInput extends Omit<SessionInput, "pluginDir"> {
  prompt: string;
  onMessage: (message: SDKMessage) => void;
}

export interface RunOutcome {
  /** 会话 id，供继续 / 打回 resume；会话没起来时为空 */
  sessionId?: string;
  /**
   * 最后一条 result 消息。读花费只取它的 total_cost_usd，不跨 result 累加：resume 的会话
   * 会续上转录里保存的累计值（Phase 0 实测 0.0518 > 0.0479）
   */
  result?: SDKResultMessage;
  /** 会话在拿到 result 之前就抛了（进程起不来、被中止、网络断） */
  error?: string;
  /** 是被调用方的 AbortController 中止的（中止 / 熔断），不是自己出的错 */
  aborted?: boolean;
  /**
   * 调用方自己的 onMessage 抛了（例如落库失败）。和 SDK 的错误分开报：否则最后一条
   * 消息没存进去也会被当成「以 result 为准」而悄悄吞掉（复审）
   */
  callbackError?: string;
}

export async function runAgent(input: RunInput): Promise<RunOutcome> {
  const { prompt, onMessage, ...session } = input;
  const outcome: RunOutcome = {};
  try {
    const options = buildSessionOptions({
      ...session,
      pluginDir: ensureAgentPlugin(),
      binDir: ensureHypitBin(),
      secretsFile: paths.secrets,
      hypitRoot: config.hypitRoot,
    });
    for await (const message of query({ prompt, options })) {
      if (message.type === "system" && message.subtype === "init") outcome.sessionId = message.session_id;
      if (message.type === "result") outcome.result = message;
      try {
        onMessage(message);
      } catch (error) {
        // 记下第一处就够：之后的消息照常往下交，别因为一条没存进去就把会话掐掉
        outcome.callbackError ??= error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    // 单次 query 在产出错误 result 之后也会抛（官方文档：single-shot query throws after
    // yielding an error result）。已经拿到 result 的，以 result 为准，不再当成进程故障
    if (!outcome.result) outcome.error = error instanceof Error ? error.message : String(error);
  }
  if (session.abortController?.signal.aborted) outcome.aborted = true;
  return outcome;
}
