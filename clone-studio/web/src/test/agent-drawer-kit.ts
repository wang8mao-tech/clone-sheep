/**
 * 抽屉组件测试的假后端：分页语义照 server/src/agent/message-store.ts（nextSeq / hasNewer / hasOlder），
 * 用例改 `db` 模拟新消息落库、任务状态变化。只桩 fetch，组件、react-query、取数循环全是真的。
 */
import type { AgentJobView, AgentMessageView, MessagePage } from "../lib/agent.js";
import { agentJob } from "./agent-fixtures.js";
import { stubFetch, type RouteStub } from "./harness.js";

export const TPL = "tpl-1";

export interface DrawerDb {
  job: AgentJobView | null;
  messages: AgentMessageView[];
  pageSize: number;
  budgetUsd: number;
  abortCalls: number;
}

export function drawerBackend(init: Partial<DrawerDb> = {}, extra: Record<string, RouteStub | (() => RouteStub)> = {}) {
  const db: DrawerDb = { job: agentJob(), messages: [], pageSize: 500, budgetUsd: 5, abortCalls: 0, ...init };
  const lastSeq = () => db.messages.at(-1)?.seq ?? 0;
  const page = (list: AgentMessageView[], afterSeq: number, truncated: boolean, history = false): MessagePage => {
    const firstSeq = list[0]?.seq ?? 0;
    const last = list.at(-1)?.seq ?? 0;
    return {
      messages: list,
      hasOlder: firstSeq > 0 && db.messages.some((m) => m.seq < firstSeq) && firstSeq > afterSeq + 1,
      hasNewer: history ? last < lastSeq() : truncated || (last > 0 && last < lastSeq()),
      firstSeq,
      lastSeq: last,
      nextSeq: history ? 0 : last > 0 ? last : afterSeq,
      jobLastSeq: lastSeq(),
    };
  };
  const calls: string[] = [];

  stubFetch({
    [`/api/templates/${TPL}/agent-job`]: () => {
      calls.push("snapshot");
      if (!db.job) return { body: { job: null, ...page([], 0, false) } };
      return { body: { job: db.job, ...page(db.messages.slice(-db.pageSize), 0, false) } };
    },
    "/api/agent-jobs/:id": () => {
      calls.push("head");
      return { body: { job: db.job, jobLastSeq: lastSeq() } };
    },
    "/api/agent-jobs/:id/messages": (_init, url) => {
      const q = new URL(url ?? "", "http://x").searchParams;
      const before = q.get("beforeSeq");
      if (before !== null) {
        calls.push(`before:${before}`);
        const older = db.messages.filter((m) => m.seq < Number(before));
        return { body: page(older.slice(-db.pageSize), 0, false, true) };
      }
      const after = Number(q.get("afterSeq") ?? 0);
      calls.push(`after:${after}`);
      const newer = db.messages.filter((m) => m.seq > after);
      return { body: page(newer.slice(0, db.pageSize), after, newer.length > db.pageSize) };
    },
    "/api/settings": () => ({ body: { agentBudgetUsd: db.budgetUsd } }),
    "POST /api/agent-jobs/:id/abort": () => {
      db.abortCalls += 1;
      if (!db.job) return { status: 404, body: { error: { message: "Agent 任务不存在" } } };
      db.job = {
        ...db.job,
        status: "interrupted",
        stopReason: "user_abort",
        runElapsedMs: 83_000,
        runStartedAt: db.job.runStartedAt,
      };
      return { body: { job: db.job } };
    },
    ...extra,
  });
  return { db, calls };
}
