import { describe, expect, it } from "vitest";
import { flush, init, job, setup, success, useTempDataRoot } from "./scheduler-test-kit.js";

/** 验货打回（REQ-004）：意见作为 `rework` 一轮 resume 进原会话，只对最新的、已完成的任务 */

useTempDataRoot();

describe("打回", () => {
  it("完成的任务：resume 原会话，这一轮记成 rework，拿满额的花费与墙钟，跑完回到完成", async () => {
    const { scheduler, store, calls, runStarts } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    calls[0]!.finish({ sessionId: "s-1", result: success(0.3) as never });
    await flush();
    expect(store.requireJob(j.id).status).toBe("done");

    scheduler.rework(j.id, "验货打回意见 #2：\n节奏快一点");
    expect(calls[1]!.input.resume).toBe("s-1");
    expect(calls[1]!.input.prompt).toBe("验货打回意见 #2：\n节奏快一点");
    expect(calls[1]!.input.maxBudgetUsd).toBe(calls[0]!.input.maxBudgetUsd);
    expect(runStarts.at(-1)).toEqual({ jobId: j.id, kind: "rework", prompt: "验货打回意见 #2：\n节奏快一点" });
    expect(store.requireJob(j.id)).toMatchObject({ status: "running", ended_at: null });

    calls[1]!.finish({ sessionId: "s-1", result: success(0.2) as never });
    await flush();
    expect(store.requireJob(j.id).status).toBe("done");
  });

  it("没完成的（熔断 / 中断 / 在跑）：NOT_REWORKABLE；会话没起来的：NO_SESSION；都不起运行", async () => {
    const { scheduler, calls } = await setup();
    const j = scheduler.enqueue(job("t1"));
    expect(() => scheduler.rework(j.id, "x")).toThrow(expect.objectContaining({ code: "NOT_REWORKABLE" }));
    await scheduler.abort(j.id);
    expect(() => scheduler.rework(j.id, "x")).toThrow(expect.objectContaining({ code: "NOT_REWORKABLE" }));

    const k = scheduler.enqueue(job("t2"));
    // 会话一直没起来就「完成」了（不带 init）：库里没有会话 id，意见没处接
    calls[1]!.finish({ result: success(0) as never });
    await flush();
    expect(() => scheduler.rework(k.id, "x")).toThrow(expect.objectContaining({ code: "NO_SESSION" }));
    expect(calls).toHaveLength(2);
  });

  it("不是最新的任务（已被重跑取代）：SUPERSEDED", async () => {
    const { scheduler, calls, store } = await setup();
    const j = scheduler.enqueue(job("t1"));
    calls[0]!.emit(init("s-1"));
    calls[0]!.finish({ sessionId: "s-1", result: success(0.1) as never });
    await flush();
    // 同一模板后来又起了一个新任务（重跑 / 换参考视频后的新一轮）
    store.updateJob(j.id, { status: "done" });
    const newer = scheduler.enqueue(job("t1"));
    calls[1]!.emit(init("s-2"));
    calls[1]!.finish({ sessionId: "s-2", result: success(0.1) as never });
    await flush();
    expect(() => scheduler.rework(j.id, "x")).toThrow(expect.objectContaining({ code: "SUPERSEDED" }));
    expect(newer.id).not.toBe(j.id);
  });
});
