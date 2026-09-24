import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../db/index.js";
import type { Denial } from "./guard.js";

/**
 * Agent 流式消息落库（Spec REQ-003：消息全量落 `agent_messages`，刷新后按 seq 重放）。
 *
 * 全量存原文，不截断：抽屉要能完整回放，出问题时也要能照着原始消息复盘。给人看的摘要
 * 由前端自己折叠。宿主自己的拦截记录也进这张表（type = `host_intercept`），这样抽屉里
 * 「琥珀竖线」和消息是同一条时间线，不用另开一路。
 */

/** 宿主拦截记录在消息流里的类型名 */
export const INTERCEPT_TYPE = "host_intercept";

/** 宿主记下的「交给会话的那句话」（任务提示 / 继续 / 打回意见）在消息流里的类型名 */
export const PROMPT_TYPE = "host_prompt";

/**
 * 打回意见在排队那一刻就落一笔（开跑时才有 host_prompt）：排队中被中止、或后端在它开跑前重启，
 * 「继续」靠它把意见接着交给会话（7.2 审查第二轮 S2-M1）。抽屉不画它
 */
export const REWORK_PENDING_TYPE = "host_rework_pending";

/** 宿主停下一段运行的记录在消息流里的类型名 */
export const STOP_TYPE = "host_stop";

/** 给界面的一条消息：payload 已经解析好，字段名与界面一致 */
export interface AgentMessageView {
  seq: number;
  role: string | null;
  type: string;
  /** 原始消息（SDK 消息或宿主拦截记录），不截断 */
  payload: unknown;
  createdAt: string;
}

/**
 * 一页消息。两个方向分开说，别用一个 hasMore 混着讲（复审 S1-M1）：
 * - `hasOlder`：这一页之前还有，用 `beforeSeq = firstSeq` 往前翻
 * - `hasNewer`：这一页之后还有，用 `afterSeq = nextSeq` 再拉一次
 *
 * 合成一个布尔值的话，「尾页被字节预算截短了、后面还有没拿到的」会被前端当成「前面还有」，
 * 于是它一直往前翻，而缺的恰恰是最后一条 result。
 */
export interface MessagePage {
  messages: AgentMessageView[];
  hasOlder: boolean;
  hasNewer: boolean;
  /** 本页第一条 / 最后一条的 seq；空页是 0 */
  firstSeq: number;
  lastSeq: number;
  /**
   * **往后拉的游标就用它**：下次带 `afterSeq = nextSeq`。
   *
   * 它等于本页最后一条的 seq；本页是空的（已经追平）时等于你这次传进来的 `afterSeq`，
   * 所以照抄它永远不会让游标倒退、也永远不会跳过中间没拿到的消息。
   * 别拿 `lastSeq` 当游标（空页是 0，游标会倒回开头），也别拿 `jobLastSeq`
   * （那是库里最后一条，页被截短时中间那些就永远拉不到了，复审 S1-M4 / S1-M7）。
   *
   * 往前翻（`beforeSeq`）拿到的页恒为 0：那种页只用来显示历史，拿它当游标会把游标
   * 倒回你早就看过的地方（复审 S1-L1）。
   */
  nextSeq: number;
  /** 这个任务当前最后一条的 seq。只用来判断「追平了没有」，不是游标 */
  jobLastSeq: number;
}

/** 一页最多几条 */
export const PAGE_LIMIT = 500;

/**
 * 一页最多多少字节（不是一条）。单条消息按 Spec 全量存、不截断，所以读一页的内存峰值是
 * 「这个预算 + 正在看的那一条」——真要防住几百 MB 的单条工具输出，只能在写入侧限
 * （复审 S2-L4 / S2-L10）。
 */
export const PAGE_BYTE_BUDGET = 4 * 1024 * 1024;

export interface InterceptRecord extends Denial {
  tool: string;
  agentId?: string;
}

/** 落一条 SDK 消息，返回它的 seq */
export function appendMessage(jobId: string, message: SDKMessage): { seq: number; type: string } {
  const role = message.type === "assistant" || message.type === "user" ? message.type : null;
  return insert(jobId, role, message.type, message);
}

/** 落一条宿主拦截记录（AC-007：宿主自己的日志里有一条「已拦截」） */
export function appendIntercept(jobId: string, denial: InterceptRecord): { seq: number; type: string } {
  return insert(jobId, null, INTERCEPT_TYPE, denial);
}

/**
 * 落一条「交给会话的那句话」：会话走流式输入，SDK 不回显，不记的话抽屉里永远看不到 Agent 在做什么任务。
 * 全文照存，和别的消息一样不截断。
 */
export function appendPrompt(jobId: string, run: { kind: string; prompt: string }): { seq: number; type: string } {
  return insert(jobId, "user", PROMPT_TYPE, { kind: run.kind, text: run.prompt });
}

export function appendReworkPending(jobId: string, prompt: string): void {
  insert(jobId, null, REWORK_PENDING_TYPE, { text: prompt });
}

/** 落一条「宿主在这里停下了这段运行」：抽屉据此把会话收尾那条 result 当成「被停下」而不是出错 */
export function appendStop(jobId: string, stop: { reason: string }): { seq: number; type: string } {
  return insert(jobId, null, STOP_TYPE, { reason: stop.reason });
}

/**
 * 增量：`afterSeq` 之后的消息，按 seq 升序。SSE 只带 seq，前端收到就拿它来补（AC-009）。
 * 截断时 `hasNewer` 为真，按 `nextSeq` 接着拉，不会悄悄少一段（复审 S1-L2）。
 */
export function listMessages(jobId: string, afterSeq = 0, limit = PAGE_LIMIT): MessagePage {
  const rows = stream(
    `SELECT seq, role, type, payload, created_at FROM agent_messages
     WHERE job_id = ? AND seq > ? ORDER BY seq`,
    [jobId, afterSeq],
    limit,
  );
  // 从旧往新收：预算不够时没拿到的是「更新的那些」
  return finish(jobId, rows.messages, afterSeq, rows.truncated);
}

/** 往前翻：`beforeSeq` 之前的一页（抽屉往上滚）。`beforeSeq <= 1` 时前面没有了，给空页 */
export function listMessagesBefore(jobId: string, beforeSeq: number, limit = PAGE_LIMIT): MessagePage {
  return tail(jobId, limit, beforeSeq);
}

/**
 * 最近的一页：抽屉一打开看的是对话的末尾，不是三小时前的开头（AC-009 的刷新恢复走这条）。
 * 再往前翻用 `listMessagesBefore(jobId, page.firstSeq)`。
 */
export function listRecentMessages(jobId: string, limit = PAGE_LIMIT): MessagePage {
  return tail(jobId, limit);
}

/**
 * 从末尾（或 `beforeSeq` 之前）往回取一页。倒着查、倒着收：预算不够时丢掉的必须是更旧的
 * 那些，最后一条（通常是 result）一定在页里（复审 S1-M1）。
 */
function tail(jobId: string, limit: number, beforeSeq?: number): MessagePage {
  const history = beforeSeq !== undefined;
  if (history && beforeSeq <= 1) return finish(jobId, [], 0, false, { history });
  const where = beforeSeq === undefined ? "" : " AND seq < ?";
  const params = beforeSeq === undefined ? [jobId] : [jobId, beforeSeq];
  const rows = stream(
    `SELECT seq, role, type, payload, created_at FROM agent_messages
     WHERE job_id = ?${where} ORDER BY seq DESC`,
    params,
    limit,
  );
  rows.messages.reverse();
  // 这里故意不用 rows.truncated：倒着取时被截掉的是更旧的那些，而「前面还不还有」由 finish
  // 按库里的 COUNT 算，比流式截断的标记更准（复审 S2-L1：别把它接到 forcedNewer 上）
  return finish(jobId, rows.messages, 0, false, { history });
}

/**
 * 逐行取，取够一页（条数或字节）就停。
 *
 * **必须是 iterate 不能是 all**：`all` 会先把 limit+1 行连同 payload 全部读进内存，
 * 字节预算再怎么算也是事后的——实测 500 行 × 3MB 的 all 一次就多占 60 多 MB，而这条
 * 预算的存在理由正是不让它发生（复审 S2-M1）。
 * 一条都放不下时至少给一条：宁可超预算，也不要给空页让前端以为到头了。
 */
function stream(sql: string, params: unknown[], limit: number): { messages: AgentMessageView[]; truncated: boolean } {
  const messages: AgentMessageView[] = [];
  let bytes = 0;
  let truncated = false;
  for (const raw of db()
    .prepare(sql)
    .iterate(...params) as Iterable<RawRow>) {
    if (messages.length >= limit) {
      truncated = true;
      break;
    }
    // payload 存的是 UTF-8，.length 数的是 UTF-16 单元：中文会差三倍，按字节算才对得上预算名
    bytes += Buffer.byteLength(raw.payload);
    if (bytes > PAGE_BYTE_BUDGET && messages.length > 0) {
      truncated = true;
      break;
    }
    messages.push({
      seq: raw.seq,
      role: raw.role,
      type: raw.type,
      payload: parse(raw.payload),
      createdAt: raw.created_at,
    });
  }
  return { messages, truncated };
}

interface RawRow {
  seq: number;
  role: string | null;
  type: string;
  payload: string;
  created_at: string;
}

/**
 * 两个方向各自判断还有没有：前面看第一条之前有没有，后面看最后一条是不是全库最后一条。
 * `options.history` 标的是「这是往前翻拿到的页」：那种页不给往后拉的游标（`nextSeq` 恒 0），
 * `hasNewer` 也只表示「库里还有更新的」——调用方多半已经有了（复审 S1-L1 / S1-L3 / S1-L4）。
 */
function finish(
  jobId: string,
  messages: AgentMessageView[],
  afterSeq: number,
  forcedNewer: boolean,
  options: { history?: boolean } = {},
): MessagePage {
  const firstSeq = messages[0]?.seq ?? 0;
  const pageLast = messages.at(-1)?.seq ?? 0;
  const before = firstSeq > 0 ? countBefore(jobId, firstSeq) : 0;
  const jobLastSeq = lastSeq(jobId);
  return {
    messages,
    hasOlder: before > 0 && firstSeq > afterSeq + 1,
    hasNewer: options.history ? pageLast < jobLastSeq : forcedNewer || (pageLast > 0 && pageLast < jobLastSeq),
    firstSeq,
    lastSeq: pageLast,
    nextSeq: options.history ? 0 : pageLast > 0 ? pageLast : afterSeq,
    jobLastSeq,
  };
}

function countBefore(jobId: string, seq: number): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE job_id = ? AND seq < ?").get(jobId, seq) as {
    n: number;
  };
  return row.n;
}

/** 存进去的一定是自己序列化的 JSON；真坏了也不能让整页拉不出来 */
function parse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return { type: "unparsable", raw: payload };
  }
}

/** 这个任务已经存到第几条：前端拉完快照后带着它订阅 */
export function lastSeq(jobId: string): number {
  const row = db().prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_messages WHERE job_id = ?").get(jobId) as {
    seq: number;
  };
  return row.seq;
}

/**
 * 取号和写入用同一条语句：seq 在 SQL 里算，不经过 JS 来回一趟，也就没有「取到号还没写进去」
 * 的中间态。唯一索引（job_id, seq）是最后一道。
 */
function insert(jobId: string, role: string | null, type: string, payload: unknown): { seq: number; type: string } {
  const row = db()
    .prepare(
      `INSERT INTO agent_messages (job_id, seq, role, type, payload, created_at)
       SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ? FROM agent_messages WHERE job_id = ?
       RETURNING seq`,
    )
    .get(jobId, role, type, JSON.stringify(payload), new Date().toISOString(), jobId) as { seq: number };
  return { seq: row.seq, type };
}
