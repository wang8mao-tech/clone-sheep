import { describe, expect, it } from "vitest";
import { flush, init, job, setup, useTempDataRoot } from "./scheduler-test-kit.js";

/** 调度器：订阅限流的等待额度、自动续跑，以及「用时」怎么算（Task 5.3 复审 S1-M1(r6) / S1-M1(r7)） */
useTempDataRoot();

/**
 * 抽屉算「用时」的那条公式，照 AgentJobView 的注释原样抄一遍（复审 S1-M1(r6)）。
 * `now` 必须传测试时钟的当下：库里的 run_started_at 也是这只时钟写的，拿 Date.now() 去减
 * 等于两把尺子量一个数，算出来差着几十年，断言也就永远失效（复审 S2-M1(r7)）。
 */
function elapsed(row: { status: string; run_started_at: string | null; run_elapsed_ms: number }, now: number): number {
  const segment = row.status === "running" && row.run_started_at ? now - Date.parse(row.run_started_at) : 0;
  return row.run_elapsed_ms + segment;
}

describe("订阅限流：等待额度并到点自动续跑", () => {
  it("rejected → 等待额度（记续跑时间）→ 到点 resume 同一会话，只拿剩下的预算", async () => {
    const { scheduler, store, calls, clock, runStarts, runStops } = await setup({ budgetUsd: 5 });
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
    // 等额度后的续跑是宿主自己发起的，抽屉按 auto_resume 画分隔，不当成人点的继续
    expect(runStarts.map((r) => r.kind)).toEqual(["start", "auto_resume"]);
    // 被限流停下的那一段也是宿主停的
    expect(runStops).toEqual([{ jobId: j.id, reason: "awaiting_quota" }]);
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

  it("等额度续跑是同一次运行：用时接着走，干等的一小时不算（复审 S1-M3 / S1-M6）", async () => {
    const { scheduler, store, calls, clock } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    expect(store.requireJob(j.id).run_elapsed_ms).toBe(0); // 这次运行从 0 起算

    for (let i = 0; i < 20; i++) {
      clock.advance(60_000);
      calls[0]!.emit({ type: "tool_progress" }); // 心跳：不然 10 分钟无消息先熔断了
    }
    calls[0]!.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    await flush();
    // 限流事件没给重置时间，等的就是兜底时长；正好推到那一刻，下面才好拿 clock.now() 对起点
    const { QUOTA_FALLBACK_MS } = await import("./breaker.js");
    clock.advance(QUOTA_FALLBACK_MS); // 到点自动续跑

    expect(calls).toHaveLength(2);
    const resumed = store.requireJob(j.id);
    expect(resumed.status).toBe("running");
    // 跑掉的 20 分钟带过来接着算（没归零），干等的一小时一分不算（复审 S1-M3 / S1-M6）
    expect(resumed.run_elapsed_ms).toBe(20 * 60_000);
    // 新一段的起点正好是「现在」，不是未来：按公式算这一刻的用时恰好是跑掉的那 20 分钟，
    // 起点被挪到未来的话这里会直接变成负数（复审 S1-M1(r6) / S2-M1(r7)）
    expect(Date.parse(resumed.run_started_at as string)).toBe(clock.now());
    expect(elapsed(resumed, clock.now())).toBe(20 * 60_000);
    // 再跑 2 分钟：running 这一段真的会往前走，用时不是冻死的
    clock.advance(2 * 60_000);
    expect(elapsed(store.requireJob(j.id), clock.now())).toBe(22 * 60_000);
  });

  it("额度用光就不再续跑：熔断这条终态也要记下这一段的用时（复审 S1-M1(r7)）", async () => {
    // 预算只够这一段：限流到点后 planQuotaResume 判定没得跑了，直接熔断
    const { scheduler, store, calls, clock, runStops } = await setup({ budgetUsd: 1 });
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    for (let i = 0; i < 7; i++) {
      clock.advance(60_000);
      calls[0]!.emit({ type: "tool_progress" });
    }
    calls[0]!.spent = 1; // 预算花光
    calls[0]!.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    await flush();

    const tripped = store.requireJob(j.id);
    expect(tripped.status).toBe("tripped");
    expect(tripped.stop_reason).toMatch(/^budget/);
    // 跑了 7 分钟就得显示 7 分钟。不记这一笔的话，界面上是「原因：花费达到上限 / 用时 0 秒」
    expect(elapsed(tripped, clock.now())).toBe(7 * 60_000); // 停下记录写真正的原因：不会续跑了，抽屉不能说「额度受限，等恢复后续跑」（复审 S1-R3-2）
    expect(runStops).toEqual([{ jobId: j.id, reason: expect.stringMatching(/^budget/) }]);
  });

  it("等额度期间用时冻住：不虚高、不倒退、不为负（复审 S1-M3 / S1-M1(r6)）", async () => {
    const { scheduler, store, calls, clock } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    for (let i = 0; i < 5; i++) {
      clock.advance(60_000);
      calls[0]!.emit({ type: "tool_progress" });
    }
    calls[0]!.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    await flush();

    const waiting = store.requireJob(j.id);
    expect(waiting.status).toBe("awaiting_quota");
    // 等待期间界面照 runElapsedMs + (running ? now - runStartedAt : 0) 算：不在运行中，
    // 结果恒等于已经跑掉的 5 分钟——干等几小时既不会虚高，也不会因为起点被挪到未来而变成负数
    expect(waiting.run_elapsed_ms).toBe(5 * 60_000);
    expect(elapsed(waiting, clock.now())).toBe(5 * 60_000);
    const { QUOTA_FALLBACK_MS } = await import("./breaker.js");
    clock.advance(QUOTA_FALLBACK_MS - 1); // 还没到点：再干等一段，用时纹丝不动
    const still = store.requireJob(j.id);
    expect(still.status).toBe("awaiting_quota");
    expect(elapsed(still, clock.now())).toBe(5 * 60_000);
  });

  it("等额度结束但还排着队时，用时依旧冻在已经跑掉的那些（复审 S1-M8）", async () => {
    const { scheduler, store, calls, clock } = await setup({ concurrency: 1 });
    const a = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    clock.advance(3 * 60_000);
    calls[0]!.emit({ type: "tool_progress" });
    calls[0]!.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    await flush();

    scheduler.enqueue(job("t2")); // 占住唯一的名额，a 到点后只能排队
    const { QUOTA_FALLBACK_MS } = await import("./breaker.js");
    clock.advance(QUOTA_FALLBACK_MS);

    const queued = store.requireJob(a.id);
    expect(queued.status).toBe("queued"); // 还没轮到它跑
    // 排队也不计时：干等的那段和这段队列时间都不算进用时
    expect(elapsed(queued, clock.now())).toBe(3 * 60_000);
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
