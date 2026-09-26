import { describe, expect, it } from "vitest";
import { boot, until, useCloneSandbox, type Booted } from "./clone-test-kit.js";
import { productionStatus, released, templateStatus } from "./build-test-kit.js";

/**
 * ③ 验货（REQ-004 后半、AC-013 / AC-040 后端）：版本列表、通过、打回。
 * 打回走真的调度器（假 runner）：意见 resume 原会话 → 宿主核判据 → 估价 → 出片 → 下一版。
 */

useCloneSandbox();

/** 判据通过 → 估价 $0 auto → 假 build 出完 → 模板等验货；返回 v1 的 id */
async function reviewing(b: Booted): Promise<string> {
  const id = await released(b);
  await until(() => templateStatus(b) === "awaiting_review", "等验货");
  return id;
}

async function review() {
  return import("./review.js");
}

const prompts = (b: Booted, jobId: string) =>
  (
    b
      .db()
      .prepare("SELECT payload FROM agent_messages WHERE job_id = ? AND type = 'host_prompt' ORDER BY seq")
      .all(jobId) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as { kind: string; text: string });

describe("版本列表", () => {
  it("v1 出完：一个版本、带播放地址，可通过、可打回，下一轮是第 2 轮", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    const state = (await review()).reviewState(b.templateId);
    expect(state).toMatchObject({
      templateStatus: "awaiting_review",
      approvedReplicaId: null,
      approvable: true,
      reworkable: true,
      nextRound: 2,
    });
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]).toMatchObject({
      id: v1,
      version: 1,
      status: "done",
      videoUrl: `/api/productions/${v1}/video`,
      build: { status: "done" },
    });
  });

  it("只列这一轮的：当前复刻任务建起来之前的复刻片（旧参考视频 / 重跑前）不在里面", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    b.db()
      .prepare(
        `INSERT INTO productions (id, template_id, kind, version, run_path, status, created_at, updated_at)
         VALUES ('old', ?, 'replica', 0, 'reference.svrun', 'done', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`,
      )
      .run(b.templateId);
    const ids = (await review()).reviewState(b.templateId).versions.map((v) => v.id);
    expect(ids).toEqual([v1]);
    // 这一轮里作废的（换参考视频时作废的没出片的那条）也不列
    b.db()
      .prepare(
        `INSERT INTO productions (id, template_id, kind, version, run_path, status, created_at, updated_at)
         VALUES ('voided', ?, 'replica', 9, 'reference.svrun', 'cancelled', ?, ?)`,
      )
      .run(b.templateId, new Date().toISOString(), new Date().toISOString());
    expect((await review()).reviewState(b.templateId).versions.map((v) => v.id)).toEqual([v1]);
  });

  it("最新一版出片失败：不可通过、不可打回（要先重试出片）", async () => {
    const b = await boot();
    b.setBuild(new Error("渲染炸了"));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "出片失败");
    const state = (await review()).reviewState(b.templateId);
    expect(state).toMatchObject({ templateStatus: "cloning", approvable: false, reworkable: false });
    expect(state.versions[0]).toMatchObject({ status: "failed", videoUrl: null, build: { status: "failed" } });
  });
});

describe("通过验货（AC-040 后端）", () => {
  it("通过最新一版：模板已验货、记下是哪一版，成片数算它；再点是 NOT_REVIEWING", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    const r = await review();
    const archive = await import("./archive.js");
    expect(archive.templateStats(archive.requireTemplate(b.templateId)).outputs).toBe(0);

    const after = r.approveReplica(b.templateId, v1);
    expect(after).toMatchObject({
      templateStatus: "approved",
      approvedReplicaId: v1,
      approvable: false,
      reworkable: false,
    });
    expect(templateStatus(b)).toBe("approved");
    expect(archive.templateStats(archive.requireTemplate(b.templateId)).outputs).toBe(1);
    expect(() => r.approveReplica(b.templateId, v1)).toThrow(expect.objectContaining({ code: "NOT_REVIEWING" }));
  });

  it("模板在等验货但最新一版没出好（被标失败）：不可通过、不可打回", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    b.db().prepare("UPDATE productions SET status = 'failed' WHERE id = ?").run(v1);
    const r = await review();
    expect(r.reviewState(b.templateId)).toMatchObject({
      templateStatus: "awaiting_review",
      approvable: false,
      reworkable: false,
    });
    expect(() => r.approveReplica(b.templateId, v1)).toThrow(expect.objectContaining({ code: "NOT_LATEST" }));
  });

  it("不是最新一版 / 不存在的 id：NOT_LATEST，模板不动", async () => {
    const b = await boot();
    await reviewing(b);
    const r = await review();
    expect(() => r.approveReplica(b.templateId, "nope")).toThrow(expect.objectContaining({ code: "NOT_LATEST" }));
    expect(templateStatus(b)).toBe("awaiting_review");
  });
});

describe("打回（AC-013 后端）", () => {
  it("意见 resume 原会话（rework 轮、#2）→ 模板回到复刻中 → 判据 → 估价 → 出 v2 → 回到等验货；v1、v2 都在，只能通过 v2", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    const r = await review();
    const firstSession = b.store.requireJob(b.latestJob()?.id as string).session_id;

    const job = r.reworkReplica(b.templateId, "  主持人太小，放大到画面一半  ");
    expect(templateStatus(b)).toBe("cloning");
    await until(() => b.calls.length === 2, "打回那一轮开跑");
    expect(b.calls[1]?.input.resume).toBe(firstSession);
    expect(b.calls[1]?.input.prompt).toContain("验货打回意见 #2");
    expect(b.calls[1]?.input.prompt).toContain("主持人太小，放大到画面一半");
    const rework = prompts(b, job.id).at(-1);
    expect(rework?.kind).toBe("rework");

    await b.finishRun(1);
    await until(() => templateStatus(b) === "awaiting_review", "v2 出完回到等验货");
    const state = r.reviewState(b.templateId);
    expect(state.versions.map((v) => [v.version, v.status])).toEqual([
      [1, "done"],
      [2, "done"],
    ]);
    expect(state.versions.every((v) => v.videoUrl !== null)).toBe(true);
    expect(state.nextRound).toBe(3);
    expect(() => r.approveReplica(b.templateId, v1)).toThrow(expect.objectContaining({ code: "NOT_LATEST" }));
    expect(r.approveReplica(b.templateId, state.versions[1]?.id as string).approvedReplicaId).toBe(
      state.versions[1]?.id,
    );
    // 成片数只算通过的那一版：v1、v2 都出完了，也只算 1 条
    const archive = await import("./archive.js");
    expect(archive.templateStats(archive.requireTemplate(b.templateId)).outputs).toBe(1);
  });

  it("意见空白或超过 2000 字：INVALID_NOTE，不起运行、模板不动", async () => {
    const b = await boot();
    await reviewing(b);
    const r = await review();
    expect(() => r.reworkReplica(b.templateId, "   ")).toThrow(expect.objectContaining({ code: "INVALID_NOTE" }));
    expect(() => r.reworkReplica(b.templateId, "字".repeat(2001))).toThrow(
      expect.objectContaining({ code: "INVALID_NOTE" }),
    );
    expect(r.reworkReplica(b.templateId, "字".repeat(2000)).status).toMatch(/queued|running/);
  });

  it("已验货的不能打回（NOT_REVIEWING）；会话没起来的任务不能打回（NOT_REWORKABLE）", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    const r = await review();
    b.db().prepare("UPDATE agent_jobs SET session_id = NULL WHERE id = ?").run(b.latestJob()?.id);
    expect(() => r.reworkReplica(b.templateId, "改一下")).toThrow(expect.objectContaining({ code: "NOT_REWORKABLE" }));
    r.approveReplica(b.templateId, v1);
    expect(() => r.reworkReplica(b.templateId, "改一下")).toThrow(expect.objectContaining({ code: "NOT_REVIEWING" }));
  });
});
