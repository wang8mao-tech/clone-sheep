import { describe, expect, it } from "vitest";
import { until, useCloneSandbox } from "../services/clone-test-kit.js";
import { bootVariants } from "../services/variant-test-kit.js";
import { inReview } from "../services/variant-review-kit.js";

/**
 * 抽屉跟随所选变体（Design-Brief §2.3，Task 9.3）：变体任务的快照接口；007 上 CMP-009 横条的「重跑」走通用重跑接口，
 * 对变体要照 ④ 的重跑清素材、运行文件（不然旧素材留着、变体状态乱）
 */

useCloneSandbox();

async function app() {
  const Fastify = (await import("fastify")).default;
  const { agentJobRoutes } = await import("./agent-jobs.js");
  const server = Fastify();
  await server.register(agentJobRoutes);
  return server;
}

describe("GET /api/productions/:id/agent-job", () => {
  it("给变体当前的任务与最近一屏消息；不存在 404", async () => {
    const b = await bootVariants();
    const { id } = await inReview(b);
    const server = await app();
    const res = await server.inject({ url: `/api/productions/${id}/agent-job` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job: { ownerKind: "production", ownerId: id, status: "done" } });
    expect(Array.isArray(res.json().messages)).toBe(true);
    expect((await server.inject({ url: "/api/productions/nope/agent-job" })).statusCode).toBe(404);
    await server.close();
  });
});

describe("POST /api/agent-jobs/:jobId/rerun 对变体的任务", () => {
  it("走变体的重跑：Agent 抓来的素材清掉、运行文件清掉、变体回到排队并开新任务", async () => {
    const b = await bootVariants();
    const { id } = await inReview(b);
    expect(b.vstore.listAssets(id).length).toBeGreaterThan(0);
    const server = await app();
    const before = (await server.inject({ url: `/api/productions/${id}/agent-job` })).json().job.id as string;
    const res = await server.inject({ method: "POST", url: `/api/agent-jobs/${before}/rerun` });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.id).not.toBe(before);
    expect(res.json().job.ownerId).toBe(id);
    expect(b.vstore.listAssets(id)).toEqual([]);
    expect(b.db().prepare("SELECT run_path FROM productions WHERE id = ?").get(id)).toEqual({ run_path: null });
    await until(() => ["queued", "agent_running"].includes(b.statusOf(id) ?? ""), "变体回到写稿");
    await server.close();
  });

  it("变体不能重跑（已交给出片、在排队估价）：409 原文照出，不开新任务", async () => {
    const b = await bootVariants();
    const { id } = await inReview(b);
    b.db().prepare("UPDATE productions SET status = 'building' WHERE id = ?").run(id);
    const server = await app();
    const job = (await server.inject({ url: `/api/productions/${id}/agent-job` })).json().job.id as string;
    const res = await server.inject({ method: "POST", url: `/api/agent-jobs/${job}/rerun` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NOT_RERUNNABLE");
    expect((await server.inject({ url: `/api/productions/${id}/agent-job` })).json().job.id).toBe(job);
    await server.close();
  });
});

describe("素材审核状态带 templateId", () => {
  it("④ 用它判断 ?variant= 是不是这个模板的", async () => {
    const b = await bootVariants();
    const { id, review } = await inReview(b);
    expect(review.reviewState(id).templateId).toBe(b.templateId);
  });
});

describe("变体此刻能做什么（owner gate，9.3 审查 S1-M1 / S1-M2）", () => {
  it("快照与任务头都带：所属模板、能否继续 / 重跑；作废之后两样都不行", async () => {
    const b = await bootVariants();
    const { id } = await inReview(b);
    const server = await app();
    const snap = (await server.inject({ url: `/api/productions/${id}/agent-job` })).json();
    // 素材待审：Agent 那一段结束了、没停下，不能继续；能重跑
    expect(snap.owner).toEqual({ templateId: b.templateId, continue: false, rerun: true });
    b.db().prepare("UPDATE productions SET status = 'cancelled' WHERE id = ?").run(id);
    const head = (await server.inject({ url: `/api/agent-jobs/${snap.job.id}` })).json();
    expect(head.owner).toEqual({ templateId: b.templateId, continue: false, rerun: false });
    await server.close();
  });

  it("拿别的标签页里看着的旧任务 id 去重跑：409，不动变体（同调度器的 SUPERSEDED）", async () => {
    const b = await bootVariants();
    const { id } = await inReview(b);
    const server = await app();
    const first = (await server.inject({ url: `/api/productions/${id}/agent-job` })).json().job.id as string;
    expect((await server.inject({ method: "POST", url: `/api/agent-jobs/${first}/rerun` })).statusCode).toBe(200);
    b.db().prepare("UPDATE productions SET status = 'failed' WHERE id = ?").run(id);
    const stale = await server.inject({ method: "POST", url: `/api/agent-jobs/${first}/rerun` });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("SUPERSEDED");
    await server.close();
  });
});
