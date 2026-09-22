import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { currentDataRoot, flush, init, job, setup, success, useTempDataRoot } from "./scheduler-test-kit.js";

/** 调度器：排队与并发、运行结局、熔断（AC-008）、继续与重跑（AC-010）。限流与取消在 scheduler-stop.test.ts */
useTempDataRoot();

describe("排队与并发", () => {
  it("并发上限 2：第三个排队，前面结束一个它才开跑", async () => {
    const { scheduler, store, calls } = await setup({ concurrency: 2 });
    const [a, b, c] = ["t1", "t2", "t3"].map((o) => scheduler.enqueue(job(o)));
    expect(calls).toHaveLength(2);
    expect(store.requireJob(c!.id).status).toBe("queued");
    expect(store.requireJob(a!.id).status).toBe("running");

    calls[0]!.finish({ result: success(0.1) as never });
    await flush();
    expect(calls).toHaveLength(3);
    expect(store.requireJob(c!.id).status).toBe("running");
    expect(store.requireJob(b!.id).status).toBe("running");
  });

  it("设置里的并发改了，下一次调度就按新值", async () => {
    const { scheduler, calls, current } = await setup({ concurrency: 1 });
    scheduler.enqueue(job("t1"));
    scheduler.enqueue(job("t2"));
    expect(calls).toHaveLength(1);
    current.concurrency = 2;
    scheduler.enqueue(job("t3"));
    expect(calls).toHaveLength(2);
  });

  it("并发设置是垃圾值：退回默认 2，不把队列锁死（复审 S2-L7）", async () => {
    const { scheduler, calls, current } = await setup();
    current.concurrency = Number.NaN;
    scheduler.enqueue(job("t1"));
    scheduler.enqueue(job("t2"));
    scheduler.enqueue(job("t3"));
    expect(calls).toHaveLength(2);
  });

  it("同一对象已有没结束的任务：拒绝再开一个", async () => {
    const { scheduler } = await setup();
    scheduler.enqueue(job("t1"));
    expect(() => scheduler.enqueue(job("t1"))).toThrow(/未结束/);
  });
});

describe("一次运行的结局", () => {
  it("成功：完成，记下会话 id 与花费；传给会话的是设置里的满额预算", async () => {
    const { scheduler, store, calls } = await setup({ budgetUsd: 5 });
    const j = scheduler.enqueue(job("t1"));
    expect(calls[0]!.input.maxBudgetUsd).toBe(5);
    // 进程按 owner 登记：删模板时按它收尸（AC-002）
    expect(calls[0]!.input.subject).toEqual({ kind: "template", id: "t1" });
    expect(calls[0]!.input.workspace).toBe(path.join(currentDataRoot(), "ws", "t1"));
    calls[0]!.emit(init("s-1"));
    calls[0]!.emit(success(0.12));
    calls[0]!.finish({ result: success(0.12) as never });
    await flush();
    expect(store.requireJob(j.id)).toMatchObject({ status: "done", session_id: "s-1", cost_usd: 0.12 });
  });

  it("会话抛错或 SDK 出错：失败，原因写明；消息落库失败也算失败", async () => {
    const { scheduler, store, calls } = await setup();
    const a = scheduler.enqueue(job("t1"));
    const b = scheduler.enqueue(job("t2"));
    calls[0]!.finish({ error: "spawn claude ENOENT" });
    calls[1]!.finish({ result: success(0.1) as never, callbackError: "disk full" });
    await flush();
    expect(store.requireJob(a.id)).toMatchObject({ status: "failed", stop_reason: "spawn claude ENOENT" });
    expect(store.requireJob(b.id)).toMatchObject({ status: "failed", stop_reason: "消息落库失败：disk full" });
  });
});

describe("熔断（AC-008）", () => {
  it("花费超过预算：已熔断，中间文件保留；继续 = resume 同一会话，拿满额预算", async () => {
    const { scheduler, store, calls, resets } = await setup({ budgetUsd: 0.2 });
    const ws = path.join(currentDataRoot(), "ws", "t1");
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, "ANALYSIS.md"), "半成品");

    const j = scheduler.enqueue(job("t1"));
    expect(calls[0]!.input.maxBudgetUsd).toBe(0.2);
    calls[0]!.emit(init("s-1"));
    const over = { type: "result", subtype: "error_max_budget_usd", total_cost_usd: 0.23, errors: [] };
    calls[0]!.emit(over);
    calls[0]!.finish({ result: over as never });
    await flush();
    expect(store.requireJob(j.id)).toMatchObject({ status: "tripped", cost_usd: 0.23 });
    expect(store.requireJob(j.id).stop_reason).toMatch(/^budget/);
    expect(existsSync(path.join(ws, "ANALYSIS.md"))).toBe(true);
    expect(resets).toEqual([]);

    scheduler.continueJob(j.id);
    expect(calls[1]!.input).toMatchObject({ resume: "s-1", maxBudgetUsd: 0.2 });
    expect(calls[1]!.input.prompt).toContain("继续完成之前的任务");
    expect(store.requireJob(j.id).status).toBe("running");
  });

  it("10 分钟无消息：中止会话，已熔断（idle）", async () => {
    const { scheduler, store, calls, clock } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    clock.advance(10 * 60_000);
    await flush();
    expect(calls[0]!.input.stopSignal?.aborted).toBe(true);
    expect(store.requireJob(j.id).status).toBe("tripped");
    expect(store.requireJob(j.id).stop_reason).toMatch(/^idle/);
  });

  it("墙钟用设置里的分钟数", async () => {
    const { scheduler, store, calls, clock } = await setup({ timeoutMinutes: 3 });
    const j = scheduler.enqueue(job("t1"));
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000);
      calls[0]!.emit({ type: "tool_progress" });
    }
    await flush();
    expect(store.requireJob(j.id).stop_reason).toMatch(/^timeout/);
  });
});

describe("继续与重跑", () => {
  it("后端重启后任务标中断，继续 resume 原会话（AC-010）", async () => {
    const first = await setup();
    const j = first.scheduler.enqueue(job("t1"));
    first.calls[0]!.emit(init("s-1"));
    // 模拟进程被杀：内存里的调度器没了，库里还是 running
    first.dbMod.closeDb();
    vi.resetModules();
    const second = await setup();
    second.migrateMod.markStaleRunningAsInterrupted();
    expect(second.store.requireJob(j.id)).toMatchObject({ status: "interrupted", stop_reason: "backend_restart" });

    second.scheduler.continueJob(j.id);
    expect(second.calls[0]!.input.resume).toBe("s-1");
  });

  it("会话没起来就被中止的任务：继续 = 原样重发任务提示（复审 S1-M2）", async () => {
    const { scheduler, store, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    // 没收到 init 就被停：库里没有会话 id，工作目录里也没有 Agent 写的东西
    await scheduler.abort(j.id);
    expect(store.requireJob(j.id)).toMatchObject({ status: "interrupted", session_id: null });
    scheduler.continueJob(j.id);
    expect(calls[1]!.input.prompt).toBe("复刻 t1");
    expect(calls[1]!.input.resume).toBeUndefined();
  });

  it("会话没起来时带着打回意见继续：报错，不把意见悄悄丢掉（复审 S2-L3）", async () => {
    const { scheduler, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    await scheduler.abort(j.id); // 没有 init：库里没有会话 id
    expect(() => scheduler.continueJob(j.id, "主持人太小，放大一点")).toThrow(
      expect.objectContaining({ code: "NO_SESSION" }),
    );
    expect(calls).toHaveLength(1);
  });

  it("重启时还在排队的任务标了中断，继续照样能跑（复审 S1-M2 / AC-010）", async () => {
    const first = await setup({ concurrency: 1 });
    first.scheduler.enqueue(job("t0"));
    const queued = first.scheduler.enqueue(job("t1"));
    first.dbMod.closeDb();
    vi.resetModules();
    const second = await setup();
    second.migrateMod.markStaleRunningAsInterrupted();
    expect(second.store.requireJob(queued.id)).toMatchObject({ status: "interrupted", session_id: null });

    second.scheduler.continueJob(queued.id);
    expect(second.calls[0]!.input.prompt).toBe("复刻 t1");
    expect(second.calls[0]!.input.resume).toBeUndefined();
    expect(second.store.requireJob(queued.id).status).toBe("running");
  });

  it("完成的任务不能继续", async () => {
    const { scheduler, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    calls[0]!.finish({ result: success(0.1) as never });
    await flush();
    expect(() => scheduler.continueJob(j.id)).toThrow(/只有已熔断/);
  });

  it("重跑：先清 Agent 产物，再按原提示开新任务（新会话，不 resume）", async () => {
    const { scheduler, store, calls, resets } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    await scheduler.abort(j.id);

    const again = scheduler.rerun(j.id);
    expect(resets).toEqual([j.id]);
    expect(again.id).not.toBe(j.id);
    expect(calls[1]!.input.prompt).toBe("复刻 t1");
    expect(calls[1]!.input.resume).toBeUndefined();
    expect(store.requireJob(j.id).status).toBe("interrupted");
  });

  it("没结束的、已完成的任务不能重跑（复审 S1-L1：完成的可能已验货通过）", async () => {
    const { scheduler, calls, resets } = await setup();
    const running = scheduler.enqueue(job("t1"));
    expect(() => scheduler.rerun(running.id)).toThrow(/可以重跑/);
    const done = scheduler.enqueue(job("t2"));
    calls[1]!.emit(init("s-2"));
    calls[1]!.finish({ result: success(0.1) as never });
    await flush();
    expect(() => scheduler.rerun(done.id)).toThrow(/可以重跑/);
    expect(resets).toEqual([]);
  });

  it("连点两下重跑：第二下在动文件之前就被拒，不会清掉新任务正在写的产物（复审 H2）", async () => {
    const { scheduler, calls, resets } = await setup();
    const a = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    await scheduler.abort(a.id);
    scheduler.rerun(a.id);
    expect(() => scheduler.rerun(a.id)).toThrow();
    expect(resets).toEqual([a.id]);
  });

  it("重跑之后旧任务不能再继续：两个 Agent 不会同时写一个目录（复审 H1）", async () => {
    const { scheduler, store, calls } = await setup();
    const a = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    await scheduler.abort(a.id);
    const b = scheduler.rerun(a.id);
    expect(() => scheduler.continueJob(a.id)).toThrow();
    // 新任务结束之后也不行：旧会话的产物已经被重跑清掉了
    calls[1]!.emit(init("s-2"));
    await scheduler.abort(b.id);
    expect(() => scheduler.continueJob(a.id)).toThrow(/已被重跑取代/);
    expect(store.activeJobsOf("template", "t1")).toEqual([]);
  });

  it("继续时同一对象已有别的任务没结束：拒绝（复审 S2-M4：这条要被『已有未结束任务』拦下）", async () => {
    const { scheduler, store, calls } = await setup();
    // 先造一个同对象、还没结束的任务（比如另一个入口建的），再让要继续的那个成为最新的
    store.createJob({ ownerKind: "template", ownerId: "t1", prompt: "别人的任务" });
    const a = store.createJob({ ownerKind: "template", ownerId: "t1", prompt: "复刻 t1" });
    store.updateJob(a.id, { status: "interrupted", session_id: "s-1" });
    expect(store.latestJobOf("template", "t1")?.id).toBe(a.id); // 不是被「已被重跑取代」拦的
    expect(() => scheduler.continueJob(a.id)).toThrow(expect.objectContaining({ code: "JOB_ACTIVE" }));
    expect(calls).toHaveLength(0);
  });
});
