import { describe, expect, it } from "vitest";
import { flush, init, job, setup, success } from "./scheduler-test-kit.js";
import { useTempDataRoot } from "./scheduler-test-kit.js";

/** 调度器：花费怎么记——被停下的运行、换了会话的续跑、崩溃结果、调度器自己出错 */
useTempDataRoot();

describe("被停下的运行也记花费", () => {
  it("熔断掐掉的运行：花费取 interrupt 吐的 result（复审 S2-M1）", async () => {
    const { scheduler, store, calls, clock } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    calls[0]!.spent = 0.8;
    clock.advance(10 * 60_000);
    await flush();
    expect(store.requireJob(j.id)).toMatchObject({ status: "tripped", cost_usd: 0.8 });
  });

  it("崩溃结果里清零的花费不会冲掉已记下的累计值（复审 S2-L1）", async () => {
    const { scheduler, store, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    calls[0]!.spent = 1.2;
    await scheduler.abort(j.id);
    scheduler.continueJob(j.id);
    const crash = { type: "result", subtype: "error_during_execution", total_cost_usd: 0, errors: ["crash"] };
    calls[1]!.emit(crash);
    calls[1]!.finish({ result: crash as never });
    await flush();
    expect(store.requireJob(j.id)).toMatchObject({ status: "failed", cost_usd: 1.2 });
  });

  it("要 resume 却换来一个新会话：它的花费从 0 起算，要叠在已记下的累计值上（复审 S2-L5）", async () => {
    const { scheduler, store, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    calls[0]!.spent = 0.9;
    await scheduler.abort(j.id);
    expect(store.requireJob(j.id).cost_usd).toBeCloseTo(0.9);

    scheduler.continueJob(j.id);
    expect(calls[1]!.input.resume).toBe("s-1");
    // SDK 没接上转录里的累计值，开出来的是另一个会话：total_cost_usd 从 0 起算
    calls[1]!.emit(init("s-2"));
    calls[1]!.emit(success(0.4));
    calls[1]!.finish({ result: success(0.4) as never });
    await flush();
    expect(store.requireJob(j.id)).toMatchObject({ session_id: "s-2", status: "done" });
    expect(store.requireJob(j.id).cost_usd).toBeCloseTo(1.3);
  });

  it("resume 接上了转录里的累计值：按累计值记，不重复叠加", async () => {
    const { scheduler, store, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    calls[0]!.spent = 0.9;
    await scheduler.abort(j.id);

    scheduler.continueJob(j.id);
    calls[1]!.emit(init("s-1")); // 同一个会话
    calls[1]!.emit(success(1.4)); // 累计值：0.9 + 这一段的 0.5
    calls[1]!.finish({ result: success(1.4) as never });
    await flush();
    expect(store.requireJob(j.id).cost_usd).toBeCloseTo(1.4);
  });

  it("resume 回同一会话，累计值却比已记下的还小：说明转录没接上，按叠加算（复审 S2-L8）", async () => {
    const { scheduler, store, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    calls[0]!.spent = 0.9;
    await scheduler.abort(j.id);

    scheduler.continueJob(j.id);
    calls[1]!.emit(init("s-1")); // 同一个会话 id
    calls[1]!.emit(success(0.3)); // 但 total 从 0 起算了
    calls[1]!.finish({ result: success(0.3) as never });
    await flush();
    expect(store.requireJob(j.id).cost_usd).toBeCloseTo(1.2);
  });

  it("调度器自己出错：记日志并把任务标失败，不留一条永远「运行中」的记录（复审 S2-M3）", async () => {
    await setup();
    const store = await import("./job-store.js");
    const { Scheduler } = await import("./scheduler.js");
    const logged: string[] = [];
    let thrown = false;
    const scheduler = new Scheduler({
      run: () => Promise.resolve({ result: success(0.1) as never }),
      settings: () => ({ timeoutMinutes: 45, budgetUsd: 5, concurrency: 2 }),
      workspaceOf: () => "C:/ws",
      resetWorkspace: () => {},
      // 收尾改状态那一步抛（模拟库被锁）：落在 execute 的 try 之外
      onChange: (row) => {
        if (row.status === "done" && !thrown) {
          thrown = true;
          throw new Error("database is locked");
        }
      },
      log: { error: (_detail, message) => logged.push(message) },
    });
    const j = scheduler.enqueue(job("t1"));
    await flush();
    expect(logged).toEqual(["Agent 任务调度出错"]);
    expect(store.requireJob(j.id)).toMatchObject({ status: "failed" });
    expect(store.requireJob(j.id).stop_reason).toContain("database is locked");
  });
});
