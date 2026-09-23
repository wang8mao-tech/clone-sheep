import { describe, expect, it, vi } from "vitest";
import { AgentFeed, merge } from "./agent-feed.js";
import type { AgentJobView, AgentMessageView, MessagePage, TemplateJobSnapshot } from "./agent.js";

const TPL = "tpl-1";

function job(id = "job-1", over: Partial<AgentJobView> = {}): AgentJobView {
  return {
    id,
    ownerKind: "template",
    ownerId: TPL,
    status: "running",
    sessionId: "s",
    startedAt: "2026-09-23T10:00:00.000Z",
    runStartedAt: "2026-09-23T10:00:00.000Z",
    runElapsedMs: 0,
    endedAt: null,
    costUsd: 0,
    costIsEstimate: true,
    stopReason: null,
    profileName: null,
    modelId: null,
    resumeAt: null,
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: null,
    ...over,
  };
}

function msg(seq: number): AgentMessageView {
  return { seq, role: "assistant", type: "assistant", payload: { n: seq }, createdAt: "2026-09-23T10:00:00.000Z" };
}

/**
 * 一个照着 server/src/agent/message-store.ts 写的假后端：同样的 nextSeq / hasNewer / hasOlder 语义，
 * 一页最多 `pageSize` 条（模拟条数或字节预算截短）。用例靠改 `rows` 模拟新消息落库。
 */
function fakeBackend(pageSize = 3) {
  const state = { rows: [] as number[], job: job(), snapshotSize: pageSize };
  const page = (seqs: number[], afterSeq: number, truncated: boolean, history = false): MessagePage => {
    const firstSeq = seqs[0] ?? 0;
    const last = seqs.at(-1) ?? 0;
    const jobLastSeq = state.rows.at(-1) ?? 0;
    return {
      messages: seqs.map(msg),
      hasOlder: firstSeq > 0 && state.rows.some((s) => s < firstSeq) && firstSeq > afterSeq + 1,
      hasNewer: history ? last < jobLastSeq : truncated || (last > 0 && last < jobLastSeq),
      firstSeq,
      lastSeq: last,
      nextSeq: history ? 0 : last > 0 ? last : afterSeq,
      jobLastSeq,
    };
  };
  const api = {
    templateJob: vi.fn(async (): Promise<TemplateJobSnapshot> => {
      const tail = state.rows.slice(-state.snapshotSize);
      return { job: state.job, ...page(tail, 0, false, false) };
    }),
    job: vi.fn(async () => ({ job: state.job, jobLastSeq: state.rows.at(-1) ?? 0 })),
    after: vi.fn(async (_id: string, afterSeq: number) => {
      const newer = state.rows.filter((s) => s > afterSeq);
      return page(newer.slice(0, pageSize), afterSeq, newer.length > pageSize);
    }),
    before: vi.fn(async (_id: string, beforeSeq: number) => {
      const older = state.rows.filter((s) => s < beforeSeq);
      return page(older.slice(-pageSize), 0, false, true);
    }),
  };
  return { state, api };
}

const seqs = (feed: AgentFeed) => feed.getState().messages.map((m) => m.seq);

describe("AgentFeed 取数循环", () => {
  it("第一次连上拉模板快照，拿最近一屏；之后到的消息按 afterSeq 补齐", async () => {
    const { state, api } = fakeBackend();
    state.rows = [1, 2, 3, 4, 5];
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    expect(api.templateJob).toHaveBeenCalledTimes(1);
    expect(seqs(feed)).toEqual([3, 4, 5]);
    expect(feed.getState().hasOlder).toBe(true);
    expect(feed.getState().liveAfterSeq).toBe(5);

    state.rows.push(6);
    await feed.messageArrived("job-1", 6);
    expect(api.after).toHaveBeenLastCalledWith("job-1", 5);
    expect(seqs(feed)).toEqual([3, 4, 5, 6]);
  });

  it("重连：每次 open 都重拉任务对 seq，把断线期间落库的消息补齐（事件不进重放缓冲）", async () => {
    const { state, api } = fakeBackend();
    state.rows = [1, 2];
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    // 断线期间落了 3、4、5，没有任何事件通知
    state.rows.push(3, 4, 5);
    await feed.connected();
    expect(api.job).toHaveBeenCalledTimes(1);
    expect(api.after).toHaveBeenCalledWith("job-1", 2);
    expect(seqs(feed)).toEqual([1, 2, 3, 4, 5]);
    // 已经追平：再连一次只对 seq，不再拉消息
    api.after.mockClear();
    await feed.connected();
    expect(api.job).toHaveBeenCalledTimes(2);
    expect(api.after).not.toHaveBeenCalled();
  });

  it("截短的页：按 nextSeq 一页页往后拉，不跳段；不拿 jobLastSeq 当游标", async () => {
    const { state, api } = fakeBackend(2);
    state.rows = [1];
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    state.rows.push(2, 3, 4, 5, 6, 7);
    await feed.messageArrived("job-1", 7);
    // 每页 2 条：1→3→5→7，游标每次停在页尾
    expect(api.after.mock.calls.map((c) => c[1])).toEqual([1, 3, 5]);
    expect(seqs(feed)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("空页：nextSeq 原样还回来，游标不倒退也不重复拉", async () => {
    const { state, api } = fakeBackend();
    state.rows = [1, 2, 3];
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    // 事件里的 seq 比已经拿到的新，但库里其实没有更新的（比如同一条被重复通知）
    state.rows = [1, 2, 3];
    api.job.mockResolvedValueOnce({ job: state.job, jobLastSeq: 4 });
    await feed.connected();
    expect(api.after).toHaveBeenCalledWith("job-1", 3);
    state.rows.push(4);
    await feed.messageArrived("job-1", 4);
    // 空页没有把游标倒回 0：下一次从 3 接着拉
    expect(api.after).toHaveBeenLastCalledWith("job-1", 3);
    expect(seqs(feed)).toEqual([1, 2, 3, 4]);
  });

  it("旧消息的通知不触发拉取；别的任务的通知不理", async () => {
    const { state, api } = fakeBackend();
    state.rows = [1, 2, 3];
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    await feed.messageArrived("job-1", 2);
    await feed.messageArrived("job-other", 9);
    expect(api.after).not.toHaveBeenCalled();
  });

  it("往前翻只进显示，不动往后拉的游标", async () => {
    const { state, api } = fakeBackend();
    state.rows = [1, 2, 3, 4, 5, 6, 7];
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    expect(seqs(feed)).toEqual([5, 6, 7]);
    await feed.loadOlder();
    expect(api.before).toHaveBeenLastCalledWith("job-1", 5);
    expect(seqs(feed)).toEqual([2, 3, 4, 5, 6, 7]);
    await feed.loadOlder();
    expect(api.before).toHaveBeenLastCalledWith("job-1", 2);
    expect(seqs(feed)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(feed.getState().hasOlder).toBe(false);
    // 翻完历史再来新消息：游标还在 7
    state.rows.push(8);
    await feed.messageArrived("job-1", 8);
    expect(api.after).toHaveBeenLastCalledWith("job-1", 7);
  });

  it("补齐期间又来通知：串行跑完再补一轮，不会两轮并发把游标往回写", async () => {
    const { state, api } = fakeBackend();
    state.rows = [1];
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    state.rows.push(2);
    const first = feed.messageArrived("job-1", 2);
    state.rows.push(3);
    const second = feed.messageArrived("job-1", 3);
    await Promise.all([first, second]);
    expect(seqs(feed)).toEqual([1, 2, 3]);
    // 同一时刻只有一轮在跑：没有两次带同一个游标的请求
    const cursors = api.after.mock.calls.map((c) => c[1]);
    expect(new Set(cursors).size).toBe(cursors.length);
  });

  it("模板主题推来别的任务（重跑出的新任务）：清空旧的，重拉快照", async () => {
    const { state, api } = fakeBackend();
    state.rows = [1, 2];
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    state.job = job("job-2", { createdAt: "2026-09-23T11:00:00.000Z" });
    state.rows = [1];
    await feed.jobChanged(state.job);
    expect(feed.getState().job?.id).toBe("job-2");
    expect(seqs(feed)).toEqual([1]);
    expect(api.templateJob).toHaveBeenCalledTimes(2);
  });

  it("同一任务的状态变化直接换上，不重拉；别的模板的事件不理", async () => {
    const { state, api } = fakeBackend();
    state.rows = [1];
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    await feed.jobChanged(job("job-1", { status: "done" }));
    expect(feed.getState().job?.status).toBe("done");
    await feed.jobChanged(job("job-9", { ownerId: "other" }));
    expect(feed.getState().job?.id).toBe("job-1");
    expect(api.templateJob).toHaveBeenCalledTimes(1);
  });

  it("没有任务时快照给空；取数失败显示原文，下一次成功清掉", async () => {
    const { state, api } = fakeBackend();
    api.templateJob.mockResolvedValueOnce({
      job: null,
      messages: [],
      hasOlder: false,
      hasNewer: false,
      firstSeq: 0,
      lastSeq: 0,
      nextSeq: 0,
      jobLastSeq: 0,
    });
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    expect(feed.getState()).toMatchObject({ job: null, loaded: true, messages: [] });

    api.templateJob.mockRejectedValueOnce(new Error("后端未响应"));
    await feed.connected();
    expect(feed.getState().error).toBe("后端未响应");
    state.rows = [1];
    await feed.connected();
    expect(feed.getState().error).toBeNull();
    expect(seqs(feed)).toEqual([1]);
  });

  it("首屏快照失败：不标已加载（说不清有没有任务），retry 重拉", async () => {
    const { state, api } = fakeBackend();
    state.rows = [1, 2];
    api.templateJob.mockRejectedValueOnce(new Error("HTTP 500"));
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    expect(feed.getState()).toMatchObject({ loaded: false, error: "HTTP 500", job: null });
    await feed.retry();
    expect(feed.getState()).toMatchObject({ loaded: true, error: null });
    expect(seqs(feed)).toEqual([1, 2]);
  });

  it("迟到的旧任务状态事件不清空当前任务", async () => {
    const { state, api } = fakeBackend();
    state.rows = [1, 2];
    state.job = job("job-2", { createdAt: "2026-09-23T11:00:00.000Z" });
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    await feed.jobChanged(job("job-1", { createdAt: "2026-09-23T10:00:00.000Z", status: "cancelled" }));
    expect(feed.getState().job?.id).toBe("job-2");
    expect(seqs(feed)).toEqual([1, 2]);
    expect(api.templateJob).toHaveBeenCalledTimes(1);
  });
});

describe("merge", () => {
  it("按 seq 去重排序：先订阅再拉快照会重复拿到同一条", () => {
    expect(merge([msg(1), msg(3)], [msg(3), msg(2)]).map((m) => m.seq)).toEqual([1, 2, 3]);
  });
});
