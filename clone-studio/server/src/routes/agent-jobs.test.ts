import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunInput, RunOutcome } from "../agent/runner.js";

/**
 * Agent 任务接口（Spec REQ-003，AC-009）。会话换成手动控制的假 run：验的是
 * 「消息落库 → SSE 通知 → 按 seq 拉增量」这条路，不开真会话。
 */
let dataRoot: string;
let app: FastifyInstance | undefined;
let closeDb: (() => void) | undefined;

interface Call {
  input: RunInput;
  emit(message: Record<string, unknown>): void;
  finish(outcome: RunOutcome): void;
}

async function boot() {
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
  const dbMod = await import("../db/index.js");
  (await import("../db/migrate.js")).migrate();
  closeDb = dbMod.closeDb;

  const archive = await import("../services/archive.js");
  const client = archive.createClient("客户");
  const template = archive.createTemplate(client.id, "模板");
  // 工作目录要真存在：重跑会往里面写
  mkdirSync(template.workspace_path ?? "", { recursive: true });
  writeFileSync(path.join(template.workspace_path ?? "", "hypit.runtime.json"), "{}");

  const calls: Call[] = [];
  const run = (input: RunInput) =>
    new Promise<RunOutcome>((resolve) => {
      input.stopSignal?.addEventListener("abort", () => {
        const result = { type: "result", subtype: "error_during_execution", total_cost_usd: 0.1, errors: [] };
        input.onMessage(result as never);
        resolve({ aborted: true, result: result as never });
      });
      calls.push({ input, emit: (m) => input.onMessage(m as never), finish: resolve });
    });

  const service = await import("../agent/agent-service.js");
  service.resetAgentScheduler();
  const scheduler = service.agentScheduler({ overrides: { run } });
  const { agentJobRoutes } = await import("./agent-jobs.js");
  const Fastify = (await import("fastify")).default;
  app = Fastify({ logger: false });
  await app.register(agentJobRoutes);
  await app.ready();
  return { app, scheduler, calls, template, service, sse: (await import("../lib/sse.js")).sseHub };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "cs-agent-api-"));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  closeDb?.();
  closeDb = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

const assistant = (text: string) =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] } }) as Record<string, unknown>;

describe("GET /api/templates/:id/agent-job", () => {
  it("没有任务时给 null，不是 404", async () => {
    const { app: a, template } = await boot();
    const res = await a.inject({ url: `/api/templates/${template.id}/agent-job` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ job: null, messages: [], hasOlder: false, hasNewer: false, firstSeq: 0, lastSeq: 0 });
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
    expect(body.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(body.lastSeq).toBe(2);
  });
});

describe("快照取的是末尾一页", () => {
  it("消息多过一页时，抽屉先看到的是最近的那些，不是三小时前的开头（复审 M-3）", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    const store = await import("../agent/message-store.js");
    for (let i = 1; i <= 520; i++) calls[0]!.emit(assistant(`第 ${i}`));
    expect(store.lastSeq(job.id)).toBe(520);

    const res = await a.inject({ url: `/api/templates/${template.id}/agent-job` });
    const body = res.json<{
      messages: { seq: number }[];
      hasOlder: boolean;
      hasNewer: boolean;
      firstSeq: number;
      lastSeq: number;
    }>();
    expect(body.lastSeq).toBe(520);
    expect(body.firstSeq).toBeGreaterThan(1); // 开头那些不在这一页里
    expect(body).toMatchObject({ hasOlder: true, hasNewer: false });
    expect(body.messages.at(-1)!.seq).toBe(520);
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
        { jobId: job.id, seq: 1, type: "assistant" },
        { jobId: job.id, seq: 2, type: "host_intercept" },
      ]),
    );
    // 模板页不知道 job id：状态变化也推到模板主题
    expect(events.some((e) => e.topic === `template:${template.id}`)).toBe(true);

    const res = await a.inject({ url: `/api/agent-jobs/${job.id}/messages?afterSeq=1` });
    const body = res.json<{ messages: { seq: number; type: string }[]; lastSeq: number }>();
    expect(body.messages.map((m) => m.type)).toEqual(["host_intercept"]);
    expect(body.lastSeq).toBe(2);
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
