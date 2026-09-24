import { describe, expect, it } from "vitest";
import { boot, until, uploadFile, useCloneSandbox, type Booted } from "./clone-test-kit.js";
import { released, templateStatus } from "./build-test-kit.js";

/** ③ 验货的失败路径（7.2 审查）：打回意见不丢、打回后判据不过 / 额度续跑、通过时任务在跑、换参考视频 */

useCloneSandbox();

async function reviewing(b: Booted): Promise<string> {
  const id = await released(b);
  await until(() => templateStatus(b) === "awaiting_review", "等验货");
  return id;
}

const review = () => import("./review.js");

describe("打回意见不会丢（7.2 第二轮审查 S2-M1）", () => {
  it("打回排在队里还没开跑就被中止：「继续」交的仍是那条意见，这一轮仍记成 rework", async () => {
    const b = await boot();
    await reviewing(b);
    const r = await review();
    const sched = b.service.agentScheduler();
    // 占满两个并发名额，打回只能排队
    sched.enqueue({ ownerKind: "template", ownerId: "busy-1", prompt: "占位 1" });
    sched.enqueue({ ownerKind: "template", ownerId: "busy-2", prompt: "占位 2" });
    const job = r.reworkReplica(b.templateId, "主持人太小");
    expect(b.store.requireJob(job.id).status).toBe("queued");
    await sched.abort(job.id);
    expect(b.store.requireJob(job.id).status).toBe("interrupted");
    expect(r.pendingRework(job.id)).toContain("主持人太小");

    const Fastify = (await import("fastify")).default;
    const { agentJobRoutes } = await import("../routes/agent-jobs.js");
    const server = Fastify();
    await server.register(agentJobRoutes);
    const res = await server.inject({ method: "POST", url: `/api/agent-jobs/${job.id}/continue`, payload: {} });
    expect(res.statusCode).toBe(200);
    // 腾出一个名额让它开跑
    b.calls[2]?.finish({
      sessionId: "busy",
      result: { type: "result", subtype: "success", total_cost_usd: 0 } as never,
    });
    await until(() => b.calls.some((c) => c.input.prompt.includes("主持人太小")), "打回意见交给了会话");
    const kinds = (
      b
        .db()
        .prepare("SELECT payload FROM agent_messages WHERE job_id = ? AND type = 'host_prompt'")
        .all(job.id) as Array<{
        payload: string;
      }>
    ).map((m) => (JSON.parse(m.payload) as { kind: string }).kind);
    expect(kinds.at(-1)).toBe("rework");
    expect(r.pendingRework(job.id)).toBeUndefined();
    await server.close();
  });

  it("打回开跑了（rework 提示已经记下）：之后的继续不再重交这条意见", async () => {
    const b = await boot();
    await reviewing(b);
    const r = await review();
    const job = r.reworkReplica(b.templateId, "节奏再快");
    await until(() => b.calls.length === 2, "打回开跑");
    expect(r.pendingRework(job.id)).toBeUndefined();
  });

  it("意见排上队后人另写了话继续（那一轮交出去了）：之后的继续不再翻出旧意见", async () => {
    const b = await boot();
    await reviewing(b);
    const jobId = b.latestJob()?.id as string;
    const store = await import("../agent/message-store.js");
    store.appendReworkPending(jobId, "验货打回意见 #2：\n字幕太小");
    store.appendPrompt(jobId, { kind: "continue", prompt: "按我这句改：字幕放大" });
    expect((await review()).pendingRework(jobId)).toBeUndefined();
  });

  it("后端在打回开跑前重启：排队时落下的意见还在，继续用它", async () => {
    const b = await boot();
    await reviewing(b);
    const jobId = b.latestJob()?.id as string;
    // 只有排队那一笔、没有开跑时的 rework 提示——等价于重启把内存里的队列丢了
    (await import("../agent/message-store.js")).appendReworkPending(jobId, "验货打回意见 #2：\n字幕太小");
    expect((await review()).pendingRework(jobId)).toBe("验货打回意见 #2：\n字幕太小");
  });
});

describe("打回那一轮没正常完成", () => {
  it("打回后判据不过（任务改判失败）：点继续补齐，出 v2，回到等验货", async () => {
    const b = await boot();
    await reviewing(b);
    const r = await review();
    const job = r.reworkReplica(b.templateId, "改一下时间线");
    b.setCheck({ format: "hypit.cli-check@1", ok: false, error: { message: "run 里少了 final.video" } });
    await b.finishRun(1);
    await until(() => b.store.requireJob(job.id).status === "failed", "判据不过改判失败");
    expect(templateStatus(b)).toBe("cloning");

    b.setCheck({ format: "hypit.cli-check@1", ok: true, targetCount: 1, targets: ["final.video"] });
    b.service.agentScheduler().continueJob(job.id, b.clone.continuePromptFor(job.id));
    await b.finishRun(2);
    await until(() => templateStatus(b) === "awaiting_review", "v2 出完");
    expect(r.reviewState(b.templateId).versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("额度续跑（auto_resume）不算一轮打回：下一轮编号只数 rework", async () => {
    const b = await boot();
    await reviewing(b);
    const jobId = b.latestJob()?.id as string;
    const now = new Date().toISOString();
    for (const [seq, kind] of [
      [900, "rework"],
      [901, "auto_resume"],
      [902, "continue"],
    ] as const) {
      b.db()
        .prepare(
          "INSERT INTO agent_messages (job_id, seq, role, type, payload, created_at) VALUES (?, ?, 'user', 'host_prompt', ?, ?)",
        )
        .run(jobId, seq, JSON.stringify({ kind, text: "x" }), now);
    }
    expect((await review()).reviewState(b.templateId).nextRound).toBe(3);
  });
});

describe("通过与换参考视频", () => {
  it("通过时复刻任务还在跑（被人从别处继续了）：AGENT_ACTIVE，模板不动", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    b.db().prepare("UPDATE agent_jobs SET status = 'running' WHERE id = ?").run(b.latestJob()?.id);
    const r = await review();
    expect(() => r.approveReplica(b.templateId, v1)).toThrow(expect.objectContaining({ code: "AGENT_ACTIVE" }));
    expect(templateStatus(b)).toBe("awaiting_review");
  });

  it("已验货后换参考视频：通过的是哪一版清掉，不会报一个旧 id", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    (await review()).approveReplica(b.templateId, v1);
    await b.evidence.startEvidence({
      templateId: b.templateId,
      source: { kind: "file", path: uploadFile() },
      language: "zh",
    });
    const row = b.db().prepare("SELECT approved_replica_id FROM templates WHERE id = ?").get(b.templateId);
    expect(row).toEqual({ approved_replica_id: null });
  });
});
