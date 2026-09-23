import type { AgentMessageView } from "./agent.js";

/**
 * 把落库的原始消息（SDK 消息 + 宿主拦截记录）整理成抽屉的呈现单元（Design-Brief §A.2）。
 * 纯函数：抽屉每次拿到新消息就整份重算，不在组件里累积状态。
 *
 * SDK 消息只取抽屉用得上的几个字段，其余一概不认；认不出的类型直接跳过，
 * 不让一条新类型的消息把整条时间线弄崩。
 */

export interface ToolResult {
  text: string;
  isError: boolean;
  /** 被宿主 PreToolUse hook 拒掉（拒绝原因以「已拦截」开头，见 server/src/agent/guard.ts） */
  intercepted: boolean;
  at: string;
}

export type TimelineItem =
  | { kind: "prompt"; key: string; seq: number; text: string }
  | { kind: "divider"; key: string; seq: number; label: string }
  | { kind: "text"; key: string; seq: number; text: string }
  | { kind: "thinking"; key: string; seq: number; text: string; seconds: number | null }
  | {
      kind: "tool";
      key: string;
      seq: number;
      id: string;
      name: string;
      input: unknown;
      startedAt: string;
      result: ToolResult | null;
    }
  | { kind: "intercept"; key: string; seq: number; tool: string; rule: string; detail: string; reason: string }
  | { kind: "error"; key: string; seq: number; title: string; detail: string; fromResult?: boolean }
  | { kind: "stopped"; key: string; seq: number; reason: string };

export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

export type Tone = "danger" | "warning" | null;

/** 左竖线颜色：错误 / 失败的工具红，被宿主拦截的琥珀（Design-Brief §A.2） */
export function toneOf(item: TimelineItem): Tone {
  if (item.kind === "intercept") return "warning";
  if (item.kind === "error") return "danger";
  if (item.kind === "tool" && item.result) {
    if (item.result.intercepted) return "warning";
    if (item.result.isError) return "danger";
  }
  return null;
}

export interface TodoEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

const RESULT_ERRORS: Record<string, string> = {
  error_max_budget_usd: "花费达到上限",
  error_max_turns: "对话轮数达到上限",
  error_during_execution: "会话执行出错",
  error_max_structured_output_retries: "结构化输出重试次数用完",
};

export function buildTimeline(messages: readonly AgentMessageView[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, ToolItem>();
  let prevAt: string | null = null;

  for (const m of messages) {
    const p = m.payload;
    const at = m.createdAt;
    const key = `${m.seq}`;
    if (m.type === "host_prompt" && isRecord(p)) {
      pushPrompt(items, m.seq, str(p.kind), str(p.text));
    } else if (m.type === "host_intercept" && isRecord(p)) {
      items.push({
        kind: "intercept",
        key,
        seq: m.seq,
        tool: str(p.tool),
        rule: str(p.rule),
        detail: str(p.detail),
        reason: str(p.reason),
      });
    } else if (m.type === "unparsable" || (isRecord(p) && p.type === "unparsable")) {
      items.push({ kind: "error", key, seq: m.seq, title: "这条消息无法解析", detail: rawOf(p) });
    } else if (isRecord(p) && p.type === "assistant") {
      contentOf(p).forEach((block, i) => {
        const k = `${m.seq}.${i}`;
        if (block.type === "text" && str(block.text).trim()) {
          items.push({ kind: "text", key: k, seq: m.seq, text: str(block.text) });
        } else if (block.type === "thinking" && str(block.thinking).trim()) {
          items.push({
            kind: "thinking",
            key: k,
            seq: m.seq,
            text: str(block.thinking),
            seconds: gapSeconds(prevAt, at),
          });
        } else if (block.type === "tool_use") {
          const tool: ToolItem = {
            kind: "tool",
            key: k,
            seq: m.seq,
            id: str(block.id),
            name: str(block.name),
            input: block.input,
            startedAt: at,
            result: null,
          };
          tools.set(tool.id, tool);
          items.push(tool);
        }
      });
    } else if (isRecord(p) && p.type === "user") {
      // 会话走流式输入，SDK 不回显任务提示（那句话由宿主记成 host_prompt）；这里只有工具结果
      for (const block of contentOf(p)) {
        if (block.type !== "tool_result") continue;
        const tool = tools.get(str(block.tool_use_id));
        if (!tool) continue;
        const text = resultText(block.content);
        tool.result = {
          text,
          isError: block.is_error === true,
          intercepted: block.is_error === true && text.includes("已拦截"),
          at,
        };
      }
    } else if (m.type === "host_stop" && isRecord(p)) {
      markStopped(items, m.seq, str(p.reason));
    } else if (isRecord(p) && p.type === "result" && (p.subtype !== "success" || p.is_error === true)) {
      const subtype = str(p.subtype);
      const errors = Array.isArray(p.errors) ? p.errors.map(String).join("\n") : "";
      items.push({
        kind: "error",
        key,
        seq: m.seq,
        title: RESULT_ERRORS[subtype] ?? "会话以错误结束",
        detail: [subtype, errors || str(p.result)].filter(Boolean).join("\n"),
        fromResult: true,
      });
    }
    prevAt = at;
  }
  return items;
}

/**
 * 宿主记下的「交给会话的那句话」（server/src/agent/message-store.ts appendPrompt）：
 * 第一次是任务提示；人点的继续先画一条分隔再给那句话（打回意见就是它）；等额度后的自动续跑
 * 是宿主自己说的「接着做」，只画分隔。
 */
function pushPrompt(items: TimelineItem[], seq: number, kind: string, text: string): void {
  if (kind === "continue" || kind === "auto_resume") {
    items.push({
      kind: "divider",
      key: `${seq}.d`,
      seq,
      label: kind === "continue" ? "继续运行" : "额度恢复，自动继续",
    });
  }
  if (kind !== "auto_resume" && text.trim()) items.push({ kind: "prompt", key: `${seq}`, seq, text });
}

/**
 * 宿主停下了这段运行（server/src/agent/scheduler.ts onRunStop：人点中止 / 取消、熔断、限流）。
 * 会话被停时吐的那条出错 result 是「被停下」本身，不是 Agent 出错：这一段里最后那块 result 红块换成
 * 一条中性的线，写上宿主给的原因。不靠猜 result 的字段——那是 SDK 的事（Task 5.4 复审 S1-N1）。
 */
function markStopped(items: TimelineItem[], seq: number, reason: string): void {
  const stopped: TimelineItem = { kind: "stopped", key: `${seq}`, seq, reason };
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (!it || it.kind === "divider" || it.kind === "prompt" || it.kind === "stopped") break;
    if (it.kind === "error" && it.fromResult) {
      items[i] = stopped;
      return;
    }
  }
  items.push(stopped);
}

/** 待办清单：最近一次 TodoWrite 的入参就是当前全貌（它每次都整份重写） */
export function latestTodos(messages: readonly AgentMessageView[]): TodoEntry[] | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const p = messages[i]?.payload;
    if (!isRecord(p) || p.type !== "assistant") continue;
    const blocks = contentOf(p);
    for (let j = blocks.length - 1; j >= 0; j -= 1) {
      const b = blocks[j];
      if (b?.type !== "tool_use" || b.name !== "TodoWrite" || !isRecord(b.input)) continue;
      const todos = b.input.todos;
      if (!Array.isArray(todos)) continue;
      return todos.filter(isRecord).map((t) => ({
        content: str(t.content),
        status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
        ...(typeof t.activeForm === "string" ? { activeForm: t.activeForm } : {}),
      }));
    }
  }
  return null;
}

/** 工具行上的参数摘要：挑最能说明「在干什么」的那个参数 */
export function summarizeInput(name: string, input: unknown): string {
  if (!isRecord(input)) return "";
  if (name === "TodoWrite" && Array.isArray(input.todos)) return `${input.todos.length} 项`;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "skill", "description"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return oneLine(v);
  }
  const first = Object.values(input).find((v) => typeof v === "string");
  return typeof first === "string" ? oneLine(first) : oneLine(JSON.stringify(input));
}

type Block = Record<string, unknown> & { type?: unknown };

function contentOf(p: Record<string, unknown>): Block[] {
  const content = isRecord(p.message) ? p.message.content : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .map((c) => (c.type === "text" ? str(c.text) : `[${str(c.type) || "内容"}]`))
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content, null, 2);
}

function gapSeconds(from: string | null, to: string): number | null {
  if (!from) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

function rawOf(p: unknown): string {
  if (isRecord(p) && typeof p.raw === "string") return p.raw;
  return typeof p === "string" ? p : JSON.stringify(p);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  return typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
