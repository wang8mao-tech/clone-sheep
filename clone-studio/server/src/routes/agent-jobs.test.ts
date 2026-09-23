import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assistant, boot } from "./agent-jobs-test-kit.js";

/** Agent 任务接口（Spec REQ-003，AC-009）：快照、增量、SSE、中止 / 继续 / 重跑 */

describe("GET /api/templates/:id/agent-job", () => {
  it("没有任务时给 null，不是 404", async () => {
    const { app: a, template } = await boot();
    const res = await a.inject({ url: `/api/templates/${template.id}/agent-job` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      job: null,
      messages: [],
      hasOlder: false,
      hasNewer: false,
      firstSeq: 0,
      lastSeq: 0,
      nextSeq: 0,
      jobLastSeq: 0,
    });
  });

  it("模板不存在：404 TEMPLATE_NOT_FOUND", async () => {
    const { app: a } = await boot();
    const res = await a.inject({ url: "/api/templates/nope/agent-job" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "TEMPLATE_NOT_FOUND" } });
  });

  it("刷新后恢复：最新任务 + 历史消息 + lastSeq（AC-009）", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    calls[0]!.emit({ type: "system", subtype: "init", session_id: "s-1" });
    calls[0]!.emit(assistant("先看证据"));

    const res = await a.inject({ url: `/api/templates/${template.id}/agent-job` });
    const body = res.json<{ job: { id: string; status: string }; messages: { seq: number }[]; lastSeq: number }>();
    expect(body.job).toMatchObject({ id: job.id, status: "running", ownerKind: "template" });
    // 第 1 条是宿主记的任务提示（抽屉的「用户消息」），之后才是会话自己的消息
    expect(body.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(body.messages[0]).toMatchObject({
      type: "host_prompt",
      role: "user",
      payload: { kind: "start", text: "复刻" },
    });
    expect(body.lastSeq).toBe(3);
  });
});

describe("快照取的是末尾一页", () => {
  it("消息多过一页时，抽屉先看到的是最近的那些，不是三小时前的开头（复审 M-3）", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    const store = await import("../agent/message-store.js");
    for (let i = 1; i <= 520; i++) calls[0]!.emit(assistant(`第 ${i}`));
    // 520 条会话消息 + 开跑时那条任务提示
    expect(store.lastSeq(job.id)).toBe(521);

    const res = await a.inject({ url: `/api/templates/${template.id}/agent-job` });
    const body = res.json<{
      messages: { seq: number }[];
      hasOlder: boolean;
      hasNewer: boolean;
      firstSeq: number;
      lastSeq: number;
    }>();
    expect(body.lastSeq).toBe(521);
    expect(body.firstSeq).toBeGreaterThan(1); // 开头那些不在这一页里
    expect(body).toMatchObject({ hasOlder: true, hasNewer: false });
    expect(body.messages.at(-1)!.seq).toBe(521);
  }, 20_000);
});

describe("消息增量与 SSE", () => {
  it("SSE 只带 seq，前端按它拉增量；拦截记录也在同一条流里", async () => {
    const { app: a, scheduler, calls, template, sse } = await boot();
    const events: { topic: string; data: unknown }[] = [];
    const spy = vi.spyOn(sse, "publish").mockImplementation((topic, event, data) => {
      events.push({ topic, data });
      return { id: events.length, topic, event, data };
    });
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    calls[0]!.emit(assistant("一"));
    calls[0]!.input.onIntercept({
      rule: "hypit-command",
      reason: "已拦截：出片由宿主负责",
      detail: "hypit build",
      tool: "Bash",
    });
    spy.mockRestore();

    expect(events.filter((e) => e.topic === `job:${job.id}`).map((e) => e.data)).toEqual(
      expect.arrayContaining([
        { jobId: job.id, seq: 1, type: "host_prompt" },
        { jobId: job.id, seq: 2, type: "assistant" },
        { jobId: job.id, seq: 3, type: "host_intercept" },
      ]),
    );
    // 模板页不知道 job id：状态变化也推到模板主题
    expect(events.some((e) => e.topic === `template:${template.id}`)).toBe(true);

    const res = await a.inject({ url: `/api/agent-jobs/${job.id}/messages?afterSeq=2` });
    const body = res.json<{ messages: { seq: number; type: string }[]; lastSeq: number }>();
    expect(body.messages.map((m) => m.type)).toEqual(["host_intercept"]);
    expect(body.lastSeq).toBe(3);
  });

  it("往前翻历史：beforeSeq + limit", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    for (let i = 1; i <= 6; i++) calls[0]!.emit(assistant(`第 ${i}`));

    const res = await a.inject({ url: `/api/agent-jobs/${job.id}/messages?beforeSeq=5&limit=2` });
    const body = res.json<{ messages: { seq: number }[]; hasOlder: boolean; hasNewer: boolean }>();
    expect(body.messages.map((m) => m.seq)).toEqual([3, 4]);
    expect(body).toMatchObject({ hasOlder: true, hasNewer: true });
  });

  it("任务不存在：404 JOB_NOT_FOUND", async () => {
    const { app: a } = await boot();
    const res = await a.inject({ url: "/api/agent-jobs/nope/messages" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "JOB_NOT_FOUND" } });
  });
});

describe("中止 / 继续 / 重跑", () => {
  it("中止 → 中断；继续 → resume 同一会话", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    calls[0]!.emit({ type: "system", subtype: "init", session_id: "s-1" });

    const aborted = await a.inject({ method: "POST", url: `/api/agent-jobs/${job.id}/abort` });
    expect(aborted.json()).toMatchObject({ job: { status: "interrupted", sessionId: "s-1" } });

    const resumed = await a.inject({ method: "POST", url: `/api/agent-jobs/${job.id}/continue` });
    expect(resumed.json()).toMatchObject({ job: { status: "running" } });
    expect(calls[1]!.input.resume).toBe("s-1");
  });

  it("继续时带打回意见：意见原样交给会话", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    calls[0]!.emit({ type: "system", subtype: "init", session_id: "s-1" });
    await a.inject({ method: "POST", url: `/api/agent-jobs/${job.id}/abort` });

    await a.inject({ method: "POST", url: `/api/agent-jobs/${job.id}/continue`, payload: { note: "主持人太小" } });
    expect(calls[1]!.input.prompt).toBe("主持人太小");
  });

  it("重跑：清掉 Agent 产物，开新任务", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const ws = template.workspace_path as string;
    writeFileSync(path.join(ws, "ANALYSIS.md"), "半成品");
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    calls[0]!.emit({ type: "system", subtype: "init", session_id: "s-1" });
    await a.inject({ method: "POST", url: `/api/agent-jobs/${job.id}/abort` });

    const res = await a.inject({ method: "POST", url: `/api/agent-jobs/${job.id}/rerun` });
    const body = res.json<{ job: { id: string; status: string } }>();
    expect(body.job.id).not.toBe(job.id);
    expect(body.job.status).toBe("running");
    expect(existsSync(path.join(ws, "ANALYSIS.md"))).toBe(false);
  });

  it("状态不对时按调度器的 code 出错，不是 500", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    calls[0]!.emit({ type: "system", subtype: "init", session_id: "s-1" });
    const res = await a.inject({ method: "POST", url: `/api/agent-jobs/${job.id}/continue` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "NOT_CONTINUABLE" } });
  });
});
