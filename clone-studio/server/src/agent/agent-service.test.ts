import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 调度器接进应用的那一层：工作目录怎么定、给界面的形状、删除流程的挂接 */
let dataRoot: string;
let closeDb: (() => void) | undefined;

async function load() {
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
  const dbMod = await import("../db/index.js");
  (await import("../db/migrate.js")).migrate();
  closeDb = dbMod.closeDb;
  const archive = await import("../services/archive.js");
  const service = await import("./agent-service.js");
  service.resetAgentScheduler();
  return { archive, service, db: dbMod.db, stopper: await import("../services/agent-stopper.js") };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "cs-agent-svc-"));
});

afterEach(async () => {
  const stopper = await import("../services/agent-stopper.js");
  stopper.setAgentStopper(undefined);
  closeDb?.();
  closeDb = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

describe("workspaceOf", () => {
  it("用库里记的工作目录，不按 id 现拼：目录迁移过之后拼出来的是旧路径", async () => {
    const { archive, service, db } = await load();
    const client = archive.createClient("客户");
    const template = archive.createTemplate(client.id, "模板");
    const moved = path.join(dataRoot, "搬过家的目录");
    db().prepare("UPDATE templates SET workspace_path = ? WHERE id = ?").run(moved, template.id);

    expect(service.workspaceOf({ owner_kind: "template", owner_id: template.id })).toBe(moved);
  });

  it("模板还没有工作目录：明确报错，不返回一个空路径让 Agent 写到别处", async () => {
    const { archive, service, db } = await load();
    const client = archive.createClient("客户");
    const template = archive.createTemplate(client.id, "模板");
    db().prepare("UPDATE templates SET workspace_path = NULL WHERE id = ?").run(template.id);

    expect(() => service.workspaceOf({ owner_kind: "template", owner_id: template.id })).toThrow(/还没有工作目录/);
  });

  it("变体任务：Phase 8 才定，现在明确报错而不是猜一个目录", async () => {
    const { service } = await load();
    expect(() => service.workspaceOf({ owner_kind: "production", owner_id: "p1" })).toThrow(/Phase 8/);
  });
});

describe("删除流程的挂接", () => {
  it("registerAgentStopper 之后，删对象会按 owner 停任务", async () => {
    const { service, stopper } = await load();
    service.agentScheduler({
      overrides: {
        run: (input) =>
          new Promise((resolve) => {
            input.stopSignal?.addEventListener("abort", () => resolve({ aborted: true }));
          }),
        workspaceOf: () => dataRoot,
        settings: () => ({ timeoutMinutes: 45, budgetUsd: 5, concurrency: 2 }),
      },
    });
    service.registerAgentStopper();
    const job = service.agentScheduler().enqueue({ ownerKind: "template", ownerId: "t1", prompt: "复刻" });

    // 停到的个数要如实返回：删除流程按它写「将中止 N 个任务」
    expect(await stopper.stopAgentsFor([{ kind: "template", id: "t1" }])).toBe(1);
    const { requireJob } = await import("./job-store.js");
    // 标「中断」不是「已取消」：删失败回滚后对象还在，用户还能点继续（复审 M-1）
    expect(requireJob(job.id).status).toBe("interrupted");
  });
});

describe("SSE 推送", () => {
  it("推送抛了也不能把会话判失败：真相在库里，前端下次拉就补上（复审 L-4）", async () => {
    const { service } = await load();
    const sse = await import("../lib/sse.js");
    vi.spyOn(sse.sseHub, "publish").mockImplementation(() => {
      throw new Error("socket 已经断了");
    });
    let outcomeSeen: unknown;
    const scheduler = service.agentScheduler({
      overrides: {
        workspaceOf: () => dataRoot,
        settings: () => ({ timeoutMinutes: 45, budgetUsd: 5, concurrency: 2 }),
        run: (input) => {
          input.onMessage({ type: "assistant", message: { content: [] } } as never);
          const result = { type: "result", subtype: "success", total_cost_usd: 0.1, errors: [] };
          input.onMessage(result as never);
          outcomeSeen = result;
          return Promise.resolve({ result: result as never });
        },
      },
    });
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: "t1", prompt: "复刻" });
    await new Promise((r) => setImmediate(r));
    vi.restoreAllMocks();

    const { requireJob } = await import("./job-store.js");
    expect(outcomeSeen).toBeDefined();
    expect(requireJob(job.id)).toMatchObject({ status: "done" });
    // 消息照样落库了
    const { listMessages } = await import("./message-store.js");
    expect(listMessages(job.id).messages.length).toBe(2);
  });

  it("Agent 消息发布时明确要求不进缓冲，任务状态照常进（复审 M-6）", async () => {
    const { service } = await load();
    const sse = await import("../lib/sse.js");
    const seen: { event: string; buffer: unknown }[] = [];
    vi.spyOn(sse.sseHub, "publish").mockImplementation((topic, event, data, options) => {
      seen.push({ event, buffer: options?.buffer });
      return { id: seen.length, topic, event, data };
    });
    const scheduler = service.agentScheduler({
      overrides: {
        workspaceOf: () => dataRoot,
        settings: () => ({ timeoutMinutes: 45, budgetUsd: 5, concurrency: 2 }),
        run: (input) => {
          // 真 runner 会把 result 也交给 onMessage，这里照着来
          input.onMessage({ type: "assistant", message: { content: [] } } as never);
          const result = { type: "result", subtype: "success", total_cost_usd: 0, errors: [] };
          input.onMessage(result as never);
          return Promise.resolve({ result: result as never });
        },
      },
    });
    scheduler.enqueue({ ownerKind: "template", ownerId: "t1", prompt: "复刻" });
    await new Promise((r) => setImmediate(r));
    vi.restoreAllMocks();

    expect(seen.filter((e) => e.event === "agent-message").map((e) => e.buffer)).toEqual([false, false]);
    // 状态事件要能重放：侧栏断线重连靠它
    expect(seen.filter((e) => e.event === "agent-job").every((e) => e.buffer === undefined)).toBe(true);
  });

  it("Agent 消息不进 SSE 重放缓冲：它能按 seq 补，不该把别的主题挤掉（复审 M-6）", async () => {
    await load();
    const { SseHub } = await import("../lib/sse.js");
    const hub = new SseHub(3);
    hub.publish("global", "archive", { a: 1 });
    for (let i = 0; i < 5; i++) hub.publish("job:j1", "agent-message", { seq: i }, { buffer: false });
    // 缓冲里还留着那条 archive：没被 Agent 消息挤掉
    expect(replayed(hub, ["global"], 0)).toEqual([{ event: "archive", data: { a: 1 } }]);
  });
});

describe("本次运行的起点", () => {
  it("继续时 runStartedAt 重新计时，startedAt 仍是第一次开始（复审 M-10）", async () => {
    const { service } = await load();
    const calls: { input: { stopSignal?: AbortSignal; onMessage: (m: unknown) => void } }[] = [];
    const scheduler = service.agentScheduler({
      overrides: {
        workspaceOf: () => dataRoot,
        settings: () => ({ timeoutMinutes: 45, budgetUsd: 5, concurrency: 2 }),
        run: (input) =>
          new Promise((resolve) => {
            input.stopSignal?.addEventListener("abort", () => resolve({ aborted: true }));
            calls.push({ input: input as never });
          }),
      },
    });
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: "t1", prompt: "复刻" });
    calls[0]!.input.onMessage({ type: "system", subtype: "init", session_id: "s-1" });
    const { requireJob } = await import("./job-store.js");
    const first = requireJob(job.id);
    expect(first.run_started_at).toBe(first.started_at);

    await new Promise((r) => setTimeout(r, 20));
    await scheduler.abort(job.id);
    scheduler.continueJob(job.id);
    const second = requireJob(job.id);
    expect(second.started_at).toBe(first.started_at);
    expect(Date.parse(second.run_started_at as string)).toBeGreaterThan(Date.parse(first.run_started_at as string));
  });
});

describe("present", () => {
  it("库里的 snake_case 转成界面用的 camelCase，花费带「是估算」标记", async () => {
    const { service } = await load();
    const row = {
      id: "j1",
      owner_kind: "template" as const,
      owner_id: "t1",
      session_id: "s-1",
      status: "running" as const,
      started_at: "2026-09-23T10:00:00.000Z",
      run_started_at: "2026-09-23T10:30:00.000Z",
      run_elapsed_ms: 90_000,
      ended_at: null,
      cost_usd: 0.42,
      cost_is_estimate: 1,
      stop_reason: null,
      profile_name: null,
      model_id: "claude-opus-5",
      prompt: "复刻",
      resume_at: null,
      created_at: "2026-09-23T09:59:00.000Z",
      updated_at: null,
    };
    expect(service.present(row)).toMatchObject({
      id: "j1",
      ownerKind: "template",
      sessionId: "s-1",
      costUsd: 0.42,
      costIsEstimate: true,
      modelId: "claude-opus-5",
      // 抽屉的「用时」按本次运行算，不是从任务第一次开始算（复审 M-10）：
      // runElapsedMs 是之前几段跑掉的，runStartedAt 是当前这段的起点，两个都得给（复审 S1-M1(r6)）
      startedAt: "2026-09-23T10:00:00.000Z",
      runStartedAt: "2026-09-23T10:30:00.000Z",
      runElapsedMs: 90_000,
    });
    // 任务提示不进界面：它可能很长，而且抽屉里已经有消息流了
    expect(service.present(row)).not.toHaveProperty("prompt");
  });
});

/** 用一个假 reply 收下重放的事件：SseHub 只认 raw.write / raw.writeHead */
function replayed(
  hub: { subscribe: (reply: never, topics: string[], last?: number) => () => void },
  topics: string[],
  lastEventId: number,
) {
  const chunks: string[] = [];
  const reply = {
    raw: { writeHead: () => {}, write: (c: string) => chunks.push(c), on: () => {}, writableEnded: false },
  };
  hub.subscribe(reply as never, topics, lastEventId)();
  return chunks
    .filter((c) => c.startsWith("id:"))
    .map((c) => ({
      event: /event: (.*)/.exec(c)?.[1] ?? "",
      data: (JSON.parse(/data: (.*)/.exec(c)?.[1] ?? "{}") as { data: unknown }).data,
    }));
}
