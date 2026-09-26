/**
 * `codex exec --json` 的 stdout：一行一个 JSON 事件（REQ-011）。
 *
 * - `thread.started` 带 `thread_id`：第二条找图路径 `generated_images/<thread_id>/` 要用
 * - `turn.failed`（`error.message`）与 `error`（`message`）：失败，原文进 Build 错误
 * - 例外：Codex 断流重连时也发 `type: "error"`，文案是「Reconnecting... 1/5」，它是进度不是失败
 *   （官方 exec --json 事件说明；照字面判失败会把本来能出的图判死）
 *
 * 按行切分设单行上限 4 MB：一行一直不换行（Codex 异常或被别的东西写乱）时不无限攒内存。
 */

export const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** 失败时带回的 JSONL 末段行数：够看出最后发生了什么，又不把整段会话塞进 Build 错误 */
export const TAIL_LINES = 12;
/**
 * 末段每行、每条错误原文的字数上限（11.1 审查 M2）：命令输出事件一行能有几百 KB（Codex 每次先读
 * imagegen/SKILL.md），原样带回一条 Build 错误就是几 MB。留行首（带着 type），够认出是什么事件
 */
export const MAX_TAIL_LINE_CHARS = 2_000;
export const MAX_ERROR_CHARS = 4_000;
/** 最多记几条致命错误：一直刷 error 的会话不能把原文堆成几 MB */
export const MAX_ERRORS = 8;

/** 留头也留尾：事件类型在行首，额度原话这类结论常在行尾（第二轮审查 LOW-B） */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  return `${text.slice(0, head)}…（截断，原长 ${text.length} 字）…${text.slice(text.length - (max - head))}`;
}

export class LineTooLongError extends Error {
  constructor() {
    super(`Codex 的 JSONL 输出里有一行超过 ${MAX_LINE_BYTES / 1024 / 1024} MB，已停止读取`);
    this.name = "LineTooLongError";
  }
}

/** 把字节流切成完整的行；最后一段没换行的留到下一块或 `end()` */
export class LineSplitter {
  private pending = "";

  push(chunk: string): string[] {
    const text = this.pending + chunk;
    const parts = text.split("\n");
    this.pending = parts.pop() ?? "";
    if (Buffer.byteLength(this.pending, "utf8") > MAX_LINE_BYTES) throw new LineTooLongError();
    for (const line of parts) {
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new LineTooLongError();
    }
    return parts.map((line) => line.replace(/\r$/u, "")).filter((line) => line.trim().length > 0);
  }

  end(): string[] {
    const rest = this.pending.replace(/\r$/u, "");
    this.pending = "";
    return rest.trim().length > 0 ? [rest] : [];
  }
}

export interface CodexEvents {
  threadId: string | undefined;
  /** 致命错误的原文（重连提示不算） */
  errors: string[];
  /** 最近的若干行，原样 */
  tail: string[];
}

export function emptyEvents(): CodexEvents {
  return { threadId: undefined, errors: [], tail: [] };
}

const TRANSIENT = /^Reconnecting\.\.\.\s*\d+\s*\/\s*\d+/iu;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function pushError(events: CodexEvents, message: string): void {
  if (events.errors.length < MAX_ERRORS) events.errors.push(clip(message, MAX_ERROR_CHARS));
}

/** 读一行事件，更新汇总。不是 JSON 的行只进末段，不判失败（Codex 偶尔会混进纯文本提示） */
export function readEvent(events: CodexEvents, line: string): void {
  events.tail.push(clip(line, MAX_TAIL_LINE_CHARS));
  if (events.tail.length > TAIL_LINES) events.tail.shift();
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) return;
  const record = event as Record<string, unknown>;
  if (record.type === "thread.started") {
    events.threadId ??= text(record.thread_id);
    return;
  }
  if (record.type === "error") {
    const message = text(record.message) ?? JSON.stringify(record);
    if (!TRANSIENT.test(message)) pushError(events, message);
    return;
  }
  if (record.type === "turn.failed") {
    const error = record.error;
    const message =
      error !== null && typeof error === "object" && !Array.isArray(error)
        ? text((error as Record<string, unknown>).message)
        : undefined;
    pushError(events, message ?? JSON.stringify(record));
  }
}
