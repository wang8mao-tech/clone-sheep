import { describe, expect, it, vi } from "vitest";
import { flush, init, job, setup, success, useTempDataRoot } from "./scheduler-test-kit.js";

/** 调度器：订阅限流的等待额度与自动续跑；取消、中止、删除前停任务（AC-002） */
useTempDataRoot();

describe("订阅限流：等待额度并到点自动续跑", () => {
  it("rejected → 等待额度（记续跑时间）→ 到点 resume 同一会话，只拿剩下的预算", async () => {
    const { scheduler, store, calls, clock } = await setup({ budgetUsd: 5 });
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    // 单次会话中途没有 result（复审 S2-M1）：花费要等被停时 interrupt 吐的 result 才知道
    calls[0]!.spent = 1.5;
    const resetsAt = Math.floor((clock.now() + 60 * 60_000) / 1000);
    calls[0]!.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt } });
    await flush();
    expect(store.requireJob(j.id)).toMatchObject({
      status: "awaiting_quota",
      resume_at: new Date(resetsAt * 1000).toISOString(),
    });
    expect(calls).toHaveLength(1);

    clock.advance(60 * 60_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toMatchObject({ resume: "s-1", maxBudgetUsd: 3.5 });
    expect(store.requireJob(j.id)).toMatchObject({ status: "running", resume_at: null });
  });

  it("自动续跑只拿剩下的墙钟：先跑 20 分钟被限流，续跑后再过 25 分钟就到点", async () => {
    const { scheduler, store, calls, clock } = await setup({ timeoutMinutes: 45 });
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    const tick = (call: number, minutes: number) => {
      for (let i = 0; i < minutes; i++) {
        clock.advance(60_000);
        calls[call]!.emit({ type: "tool_progress" });
      }
    };
    tick(0, 20);
    calls[0]!.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    await flush();
    clock.advance(30 * 60_000); // 等额度的时间不算运行时间
    expect(calls).toHaveLength(2);
    tick(1, 24);
    await flush();
    expect(store.requireJob(j.id).status).toBe("running");
    tick(1, 1);
    await flush();
    expect(store.requireJob(j.id).stop_reason).toMatch(/^timeout/);
  });

  it("等额度续跑是同一次运行：用时不归零重算（复审 S1-M3）", async () => {
    const { scheduler, store, calls, clock } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    const runStartedAt = store.requireJob(j.id).run_started_at;
    expect(runStartedAt).toBeTruthy();

    for (let i = 0; i < 20; i++) {
      clock.advance(60_000);
      calls[0]!.emit({ type: "tool_progress" }); // 心跳：不然 10 分钟无消息先熔断了
    }
    calls[0]!.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    await flush();
    clock.advance(60 * 60_000); // 到点自动续跑

    expect(calls).toHaveLength(2);
    // 起点还是原来那个：抽屉的「用时」接着走，不从 0 开始
    expect(store.requireJob(j.id).run_started_at).toBe(runStartedAt);
  });

  it("等待额度不占并发名额", async () => {
    const { scheduler, calls } = await setup({ concurrency: 1 });
    scheduler.enqueue(job("t1"));
    calls[0]!.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    await flush();
    scheduler.enqueue(job("t2"));
    expect(calls).toHaveLength(2);
  });

  it("等待中被中止：中断，到点也不再续跑", async () => {
    const { scheduler, store, calls, clock } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    calls[0]!.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    await flush();
    await scheduler.abort(j.id);
    clock.advance(60 * 60_000);
    expect(calls).toHaveLength(1);
    expect(store.requireJob(j.id)).toMatchObject({ status: "interrupted", resume_at: null });
  });
});

describe("取消、中止、删除前停任务", () => {
  it("取消排队中的：已取消，从没跑过", async () => {
    const { scheduler, store, calls } = await setup({ concurrency: 1 });
    scheduler.enqueue(job("t1"));
    const b = scheduler.enqueue(job("t2"));
    await scheduler.cancel(b.id);
    expect(store.requireJob(b.id).status).toBe("cancelled");
    calls[0]!.finish({ result: success(0.1) as never });
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("限流续跑后排在队里的任务被中止：中断（有会话），不是取消（复审 S1-M3）", async () => {
    const { scheduler, store, calls, clock } = await setup({ concurrency: 1 });
    const a = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    calls[0]!.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    await flush();
    scheduler.enqueue(job("t2")); // 占住唯一的名额
    clock.advance(60 * 60_000); // a 到点回到队里，排在 t2 后面
    expect(store.requireJob(a.id).status).toBe("queued");
    expect((await scheduler.abort(a.id)).status).toBe("interrupted");
    expect(store.requireJob(a.id).session_id).toBe("s-1");
  });

  it("删对象时某个任务真停不下来：往上报，不让调用方以为已经停了（复审 S2-M2）", async () => {
    const { scheduler, calls } = await setup();
    scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    // 取消这一步真失败（库写不进去之类）：stopOwner 不能把它当成「已经停了」
    vi.spyOn(scheduler, "abort").mockRejectedValue(new Error("database is locked"));
    await expect(scheduler.stopOwner("template", "t1")).rejects.toThrow(/database is locked/);
  });

  it("会话赖着不停：到上限报错，任务不占着名额（复审 S2-L6 / S2-M5）", async () => {
    const { scheduler, store, clock, calls } = await setup({ concurrency: 1 }, { ignoreStop: true });
    const { STOP_TIMEOUT_MS } = await import("./scheduler.js");
    const j = scheduler.enqueue(job("t1"));
    const stopping = scheduler.cancel(j.id);
    await flush();
    expect(store.requireJob(j.id).status).toBe("running"); // 真的还没停下来
    const settled = expect(stopping).rejects.toMatchObject({ code: "STOP_TIMEOUT" });
    clock.advance(STOP_TIMEOUT_MS);
    await settled;
    // 名额要放出来：不然这个对象之后谁也跑不了，只能重启后端
    expect(store.requireJob(j.id).status).toBe("failed");
    scheduler.enqueue(job("t2"));
    expect(calls).toHaveLength(2);
  });

  it("被丢弃的那次运行后来才结束：不改库、不抢名额、也不挡住新一轮（复审 S2-M1）", async () => {
    const { scheduler, store, clock, calls, setIgnoreStop, forwarded, intercepts } = await setup(
      { concurrency: 1 },
      { ignoreStop: true },
    );
    const { STOP_TIMEOUT_MS } = await import("./scheduler.js");
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    const stopping = scheduler.cancel(j.id);
    const settled = expect(stopping).rejects.toMatchObject({ code: "STOP_TIMEOUT" });
    clock.advance(STOP_TIMEOUT_MS);
    await settled;
    expect(store.requireJob(j.id).status).toBe("failed");

    // 人点「继续」，同一个任务又跑起来了（这一轮的会话是正常的，停得下来）
    setIgnoreStop(false);
    scheduler.continueJob(j.id);
    expect(calls).toHaveLength(2);
    calls[1]!.emit(init("s-2"));
    expect(store.requireJob(j.id).status).toBe("running");

    // 被丢弃的那次还在吐消息：会话 id 不能盖掉新一轮的，消息与拦截记录也不能算到它头上
    // （复审第六轮 S2-M1、第七轮 LOW-1）——不然抽屉里会混进上一次运行的内容
    const before = { forwarded: forwarded.length, intercepts: intercepts.length };
    calls[0]!.emit(init("s-zombie"));
    calls[0]!.input.onIntercept({ rule: "hypit-command", reason: "x", detail: "hypit build", tool: "Bash" });
    expect(store.requireJob(j.id).session_id).toBe("s-2");
    expect(forwarded).toHaveLength(before.forwarded);
    expect(intercepts).toHaveLength(before.intercepts);

    // 这时候上一次运行才姗姗来迟地结束
    calls[0]!.finish({ result: success(0.2) as never });
    await flush();
    expect(store.requireJob(j.id).status).toBe("running"); // 新一轮还在跑，没被写成 cancelled
    await scheduler.abort(j.id); // 中止按钮对新一轮仍然有效
    expect(calls[1]!.input.stopSignal?.aborted).toBe(true);
    expect(store.requireJob(j.id).status).toBe("interrupted");
  });

  it("stopOwner 可以要「已取消」那种停法", async () => {
    const { scheduler, store, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    expect(await scheduler.stopOwner("template", "t1", "cancel")).toBe(1);
    expect(store.requireJob(j.id).status).toBe("cancelled");
  });

  it("停一个已经结束的任务：报 NOT_ACTIVE，接口能分清「没做事」和「停下了」", async () => {
    const { scheduler, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.finish({ result: success(0.1) as never });
    await flush();
    await expect(scheduler.cancel(j.id)).rejects.toMatchObject({ code: "NOT_ACTIVE" });
  });

  it("取消运行中的：等会话真正结束才返回，已取消", async () => {
    const { scheduler, store, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    const cancelled = await scheduler.cancel(j.id);
    expect(calls[0]!.input.stopSignal?.aborted).toBe(true);
    // 返回时库里已经是最终状态：调用方（删模板）接着删目录不会和还在跑的会话抢文件
    expect(cancelled.status).toBe("cancelled");
    expect(store.requireJob(j.id)).toMatchObject({ status: "cancelled", stop_reason: "user_cancel" });
  });

  it("中止运行中的：中断，可以继续", async () => {
    const { scheduler, store, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    expect((await scheduler.abort(j.id)).status).toBe("interrupted");
    scheduler.continueJob(j.id);
    expect(calls[1]!.input.resume).toBe("s-1");
    expect(store.requireJob(j.id).status).toBe("running");
  });

  it("stopOwner：停掉该对象所有没结束的任务并等进程退出（AC-002）", async () => {
    const { scheduler, store, calls } = await setup({ concurrency: 1 });
    const a = scheduler.enqueue(job("t1"));
    const other = scheduler.enqueue(job("t2"));
    expect(await scheduler.stopOwner("template", "t1")).toBe(1);
    expect(calls[0]!.input.stopSignal?.aborted).toBe(true);
    // 默认「中止」：删失败回滚之后这个任务还能继续
    expect(store.requireJob(a.id).status).toBe("interrupted");
    await flush();
    // 名额空出来，别的对象的任务接着跑
    expect(store.requireJob(other.id).status).toBe("running");
  });
});
