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
 * - `hasNewer`：这一页之后还有，用 `afterSeq = lastSeq` 往后拉
 * 合成一个布尔值的话，「尾页被字节预算截短了、后面还有没拿到的」会被前端当成「前面还有」，
 * 于是它一直往前翻，而缺的恰恰是最后一条 result。
 */
export interface MessagePage {
  messages: AgentMessageView[];
  hasOlder: boolean;
  hasNewer: boolean;
  firstSeq: number;
  lastSeq: number;
}

/** 一页最多几条 */
export const PAGE_LIMIT = 500;

/** 一条消息最大多少字节还算「能一次拉走」：抽屉一屏放不下几百 KB 的工具输出 */
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
 * 增量：`afterSeq` 之后的消息，按 seq 升序。SSE 只带 seq，前端收到就拿它来补（AC-009）。
 *
 * 两道上限，缺一不可：条数挡住「一次拉一万条」，字节数挡住「两千条里每条都是几百 KB 的
 * 工具输出」——后者不挡的话，刷新一次抽屉就能让后端申请几百 MB 内存。截断了就把 `hasMore`
 * 置真，前端按 `lastSeq` 接着拉，不会悄悄少一段。
 */
export function listMessages(jobId: string, afterSeq = 0, limit = PAGE_LIMIT): MessagePage {
  const rows = db()
    .prepare(
      `SELECT seq, role, type, payload, created_at FROM agent_messages
       WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(jobId, afterSeq, limit + 1) as RawRow[];
  // 从旧往新收：截断的是「更新的那些」，所以 hasNewer
  const kept = take(rows.slice(0, limit), "forward");
  return finish(jobId, kept, afterSeq, rows.length > limit || kept.length < Math.min(rows.length, limit));
}

/** 往前翻：`beforeSeq` 之前的一页（抽屉往上滚时用） */
export function listMessagesBefore(jobId: string, beforeSeq: number, limit = PAGE_LIMIT): MessagePage {
  const rows = db()
    .prepare(
      `SELECT seq, role, type, payload, created_at FROM agent_messages
       WHERE job_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(jobId, beforeSeq, limit + 1) as RawRow[];
  rows.reverse();
  const window = rows.length > limit ? rows.slice(1) : rows;
  // 从新往旧收：截断的是「更旧的那些」
  return finish(jobId, take(window, "backward"), 0, false);
}

/**
 * 最近的一页：抽屉一打开看的是对话的末尾，不是三小时前的开头。刷新恢复走这条
 * （AC-009），再往前翻用 listMessages 的 afterSeq。
 */
export function listRecentMessages(jobId: string, limit = PAGE_LIMIT): MessagePage {
  const rows = db()
    .prepare(
      `SELECT seq, role, type, payload, created_at FROM agent_messages
       WHERE job_id = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(jobId, limit + 1) as RawRow[];
  rows.reverse();
  // 多拿的那一条在最前面：去掉它，它只是用来说明「前面还有」
  const window = rows.length > limit ? rows.slice(1) : rows;
  // 尾页从**新**往旧收：预算不够时丢掉的必须是更旧的那些，最后一条 result 一定在页里（复审 S1-M1）
  return finish(jobId, take(window, "backward"), 0, false);
}

interface RawRow {
  seq: number;
  role: string | null;
  type: string;
  payload: string;
  created_at: string;
}

/**
 * 按字节预算收下一页。`forward` 从旧往新收（丢更新的），`backward` 从新往旧收（丢更旧的）。
 * 一条都放不下时至少给一条：宁可超预算，也不要返回空页让前端以为到头了。
 */
function take(rows: RawRow[], direction: "forward" | "backward"): AgentMessageView[] {
  const order = direction === "forward" ? rows : [...rows].reverse();
  const kept: AgentMessageView[] = [];
  let bytes = 0;
  for (const row of order) {
    bytes += row.payload.length;
    if (bytes > PAGE_BYTE_BUDGET && kept.length > 0) break;
    kept.push({
      seq: row.seq,
      role: row.role,
      type: row.type,
      payload: parse(row.payload),
      createdAt: row.created_at,
    });
  }
  return direction === "forward" ? kept : kept.reverse();
}

/** 两个方向各自判断还有没有：前面看第一条之前有没有，后面看最后一条是不是全库最后一条 */
function finish(jobId: string, messages: AgentMessageView[], afterSeq: number, forcedNewer: boolean): MessagePage {
  const firstSeq = messages[0]?.seq ?? 0;
  const lastSeq_ = messages.at(-1)?.seq ?? 0;
  const before = firstSeq > 0 ? countBefore(jobId, firstSeq) : 0;
  const total = lastSeq(jobId);
  return {
    messages,
    hasOlder: before > 0 && firstSeq > afterSeq + 1,
    hasNewer: forcedNewer || (lastSeq_ > 0 && lastSeq_ < total),
    firstSeq,
    lastSeq: lastSeq_,
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
