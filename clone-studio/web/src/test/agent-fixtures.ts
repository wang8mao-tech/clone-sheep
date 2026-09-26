/**
 * Agent 消息与任务的桩。形状照 SDK 消息（assistant / user / system init / result）与
 * server/src/agent/message-store.ts 的宿主拦截记录写，只填抽屉会读的字段。
 */
import type { AgentJobView, AgentMessageView } from "../lib/agent.js";

const T0 = "2026-09-23T10:00:00.000Z";

type Block = Record<string, unknown>;

export const agentMessages = {
  init: (seq: number, createdAt = T0): AgentMessageView => ({
    seq,
    role: null,
    type: "system",
    payload: { type: "system", subtype: "init", model: "claude-opus-5", session_id: "s-1" },
    createdAt,
  }),
  /** 宿主记的「交给会话的那句话」（server/src/agent/message-store.ts appendPrompt） */
  prompt: (
    seq: number,
    kind: "start" | "continue" | "auto_resume" | "rework",
    text: string,
    createdAt = T0,
  ): AgentMessageView => ({
    seq,
    role: "user",
    type: "host_prompt",
    payload: { kind, text },
    createdAt,
  }),
  /** 宿主停下这一段的记录（server/src/agent/message-store.ts appendStop） */
  stop: (seq: number, reason: string, createdAt = T0): AgentMessageView => ({
    seq,
    role: null,
    type: "host_stop",
    payload: { reason },
    createdAt,
  }),
  assistant: (seq: number, content: Block[], createdAt = T0): AgentMessageView => ({
    seq,
    role: "assistant",
    type: "assistant",
    payload: { type: "assistant", message: { role: "assistant", content } },
    createdAt,
  }),
  toolUse: (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input }),
  toolResult: (seq: number, toolUseId: string, content: string, isError = false, createdAt = T0): AgentMessageView => ({
    seq,
    role: "user",
    type: "user",
    payload: {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
    },
    createdAt,
  }),
  intercept: (seq: number, detail: string, createdAt = T0): AgentMessageView => ({
    seq,
    role: null,
    type: "host_intercept",
    payload: {
      rule: "hypit-command",
      detail,
      reason: "已拦截：出片由宿主负责，你写到 check 通过为止。不要换写法重试。",
      tool: "Bash",
    },
    createdAt,
  }),
  result: (seq: number, subtype: string, createdAt = T0): AgentMessageView => ({
    seq,
    role: null,
    type: "result",
    payload: {
      type: "result",
      subtype,
      is_error: subtype !== "success",
      total_cost_usd: 0.12,
      ...(subtype === "success" ? { result: "完成" } : { errors: ["budget exceeded"] }),
    },
    createdAt,
  }),
};

export function agentJob(over: Partial<AgentJobView> = {}): AgentJobView {
  return {
    id: "job-1",
    ownerKind: "template",
    ownerId: "tpl-1",
    status: "running",
    sessionId: "s-1",
    startedAt: T0,
    runStartedAt: T0,
    runElapsedMs: 0,
    endedAt: null,
    costUsd: 0.42,
    costIsEstimate: true,
    stopReason: null,
    profileName: "Claude 订阅",
    modelId: "claude-opus-5",
    resumeAt: null,
    createdAt: T0,
    updatedAt: null,
    ...over,
  };
}
