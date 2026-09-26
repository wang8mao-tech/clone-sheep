import { describe, expect, it, vi } from "vitest";
import { AgentFeed } from "./agent-feed.js";
import type { TemplateJobSnapshot } from "./agent.js";
import { job, TPL } from "../test/agent-feed-kit.js";

describe("AgentFeed 跟随变体（Task 9.3，Design-Brief §2.3）", () => {
  it("给了变体 id：快照拉变体的任务，不拉模板的；模板任务的事件不串进来，变体的新任务（重跑）换过去", async () => {
    const variantJob = job("var-1", { ownerKind: "production", ownerId: "v2", status: "tripped" });
    const snap: TemplateJobSnapshot = {
      job: variantJob,
      messages: [],
      hasOlder: false,
      hasNewer: false,
      firstSeq: 0,
      lastSeq: 0,
      nextSeq: 0,
      jobLastSeq: 0,
    };
    const api = {
      templateJob: vi.fn(),
      productionJob: vi.fn(async () => snap),
      job: vi.fn(async (id: string) => ({
        job: id === "var-2" ? job("var-2", { ownerKind: "production", ownerId: "v2" }) : variantJob,
        jobLastSeq: 0,
      })),
      after: vi.fn(),
      before: vi.fn(),
    };
    const feed = new AgentFeed(TPL, api, "v2");
    await feed.connected();
    expect(api.productionJob).toHaveBeenCalledWith("v2");
    expect(api.templateJob).not.toHaveBeenCalled();
    expect(feed.getState().job?.id).toBe("var-1");

    await feed.jobChanged(job("tpl-job", { createdAt: "2099-01-01T00:00:00.000Z" }));
    expect(feed.getState().job?.id).toBe("var-1");
    // 模板任务的事件：不当成新任务、不重拉
    expect(api.productionJob).toHaveBeenCalledTimes(1);

    await feed.jobChanged(
      job("var-2", { ownerKind: "production", ownerId: "v2", createdAt: "2099-01-01T00:00:00.000Z" }),
    );
    expect(api.productionJob).toHaveBeenCalledTimes(2);
  });
});

describe("AgentFeed 跟随的变体不存在（9.3 审查 S2-L5）", () => {
  it("快照 404：当没有任务，不报红（面板自己说不存在）", async () => {
    const api = {
      templateJob: vi.fn(),
      productionJob: vi.fn(async () => {
        throw Object.assign(new Error("出片单位不存在。"), { status: 404 });
      }),
      job: vi.fn(),
      after: vi.fn(),
      before: vi.fn(),
    };
    const feed = new AgentFeed(TPL, api, "nope");
    await feed.connected();
    expect(feed.getState()).toMatchObject({ job: null, loaded: true, error: null, missing: true });
  });

  it("快照说变体属于别的模板：当没有任务", async () => {
    const api = {
      templateJob: vi.fn(),
      productionJob: vi.fn(async () => ({
        job: job("var-1", { ownerKind: "production", ownerId: "v9" }),
        messages: [],
        hasOlder: false,
        hasNewer: false,
        firstSeq: 0,
        lastSeq: 0,
        nextSeq: 0,
        jobLastSeq: 0,
        owner: { templateId: "other", continue: true, rerun: true },
      })),
      job: vi.fn(),
      after: vi.fn(),
      before: vi.fn(),
    };
    const feed = new AgentFeed(TPL, api, "v9");
    await feed.connected();
    expect(feed.getState()).toMatchObject({ job: null, loaded: true, missing: true });
  });
});

describe("AgentFeed 跟随变体：能做什么（gate）跟着变（9.3 第二轮审查）", () => {
  function variantApi(first: { status: string; owner: { continue: boolean; rerun: boolean } }) {
    const now = { ...first };
    const view = () => job("var-1", { ownerKind: "production", ownerId: "v2", status: now.status as never });
    const api = {
      templateJob: vi.fn(),
      productionJob: vi.fn(async () => ({
        job: view(),
        messages: [],
        hasOlder: false,
        hasNewer: false,
        firstSeq: 0,
        lastSeq: 0,
        nextSeq: 0,
        jobLastSeq: 0,
        owner: { templateId: TPL, ...now.owner },
      })),
      job: vi.fn(async () => ({ job: view(), jobLastSeq: 0, owner: { templateId: TPL, ...now.owner } })),
      after: vi.fn(),
      before: vi.fn(),
    };
    return { api, now, view };
  }

  it("任务停下时没有消息（判据没过）：同一任务的状态事件重拉任务头，gate 打开（S1-M2）", async () => {
    const { api, now, view } = variantApi({ status: "running", owner: { continue: false, rerun: false } });
    const feed = new AgentFeed(TPL, api, "v2");
    await feed.connected();
    expect(feed.getState().gate).toEqual({ continue: false, rerun: false });
    now.status = "failed";
    now.owner = { continue: true, rerun: true };
    await feed.jobChanged(view());
    expect(feed.getState().job?.status).toBe("failed");
    expect(feed.getState().gate).toEqual({ continue: true, rerun: true });
    // 同一变化从另一个主题再到一帧（状态没变）：不再重拉
    const calls = api.job.mock.calls.length;
    await feed.jobChanged(view());
    expect(api.job.mock.calls.length).toBe(calls);
  });

  it("变体在任务之外被取消：模板的 variants 事件重拉，gate 关上（S1-M1）", async () => {
    const { api, now } = variantApi({ status: "tripped", owner: { continue: true, rerun: true } });
    const feed = new AgentFeed(TPL, api, "v2");
    await feed.connected();
    expect(feed.getState().gate).toEqual({ continue: true, rerun: true });
    now.owner = { continue: false, rerun: false };
    feed.templateEvent("variants", {});
    await vi.waitFor(() => expect(feed.getState().gate).toEqual({ continue: false, rerun: false }));
  });

  it("跟模板时：variants 事件不重拉任务", async () => {
    const api = {
      templateJob: vi.fn(async () => ({
        job: job("tpl-job"),
        messages: [],
        hasOlder: false,
        hasNewer: false,
        firstSeq: 0,
        lastSeq: 0,
        nextSeq: 0,
        jobLastSeq: 0,
      })),
      job: vi.fn(),
      after: vi.fn(),
      before: vi.fn(),
    };
    const feed = new AgentFeed(TPL, api);
    await feed.connected();
    feed.templateEvent("variants", {});
    await feed.jobChanged(job("tpl-job", { status: "failed" }));
    expect(api.job).not.toHaveBeenCalled();
  });
});
