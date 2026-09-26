import { describe, expect, it } from "vitest";
import { boot, BUILD_OK, until, useCloneSandbox } from "./clone-test-kit.js";
import { LOCAL_PLAN, productionStatus, released } from "./build-test-kit.js";

/**
 * 「重试出片」重过闸门（6.4 第三轮审查 M2，Task 7.2）：一次放行只管一次出片；重试先重新估价，
 * 限额内自动起、超限停在待确认；批次「已花」把提交过却没出成的尝试算进去。
 */

useCloneSandbox();

const RENDER = "@hypit/render-hyperframes@1#render-visual";
const planCalls = (b: Awaited<ReturnType<typeof boot>>) => b.hypitCalls.filter((c) => c[0] === "plan").length;
const buildCount = (b: Awaited<ReturnType<typeof boot>>, id: string) =>
  (b.db().prepare("SELECT COUNT(*) AS n FROM builds WHERE production_id = ?").get(id) as { n: number }).n;

describe("重试出片重新估价", () => {
  it("限额内：重试先跑一次 plan、落新的估价，再由结论放行起片", async () => {
    const b = await boot();
    b.setBuild(new Error("第一次炸了"));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "第一次失败");
    const plansBefore = planCalls(b);
    const estimatesBefore = b.db().prepare("SELECT COUNT(*) AS n FROM estimates WHERE production_id = ?").get(id);

    b.setBuild({ lines: [], json: BUILD_OK });
    expect(b.build.retryBuild(id)).toEqual({ queued: true });
    await until(() => productionStatus(b, id) === "done", "重试出完");
    expect(planCalls(b)).toBe(plansBefore + 1);
    expect(b.db().prepare("SELECT COUNT(*) AS n FROM estimates WHERE production_id = ?").get(id)).toEqual({
      n: (estimatesBefore as { n: number }).n + 1,
    });
    expect(buildCount(b, id)).toBe(2);
  });

  it("这回超了单条限额：停在待确认，不起第二次 build；人确认后才起", async () => {
    const b = await boot();
    b.setBuild(new Error("第一次炸了"));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "第一次失败");
    // 两次之间费率变了：重试时按新费率估，$2 超过单条限额 $1.5
    b.rates.upsertRate({ capability: RENDER, unit: "request", usd: 2 });
    b.setBuild({ lines: [], json: BUILD_OK });
    b.build.retryBuild(id);
    await until(() => productionStatus(b, id) === "awaiting_cost_confirm", "待确认");
    await new Promise((r) => setTimeout(r, 50));
    expect(buildCount(b, id)).toBe(1);

    b.estimate.confirmCost(id);
    await until(() => productionStatus(b, id) === "done", "确认后出完");
    expect(buildCount(b, id)).toBe(2);
  });

  it("旧的放行不再作数：出过片的出片单位被放回排队但没重新估价，pump 不会拿上一次的结论起片", async () => {
    const b = await boot();
    b.setBuild(new Error("第一次炸了"));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "第一次失败");
    b.db().prepare("UPDATE productions SET status = 'queued' WHERE id = ?").run(id);
    expect(b.build.pumpBuilds()).toBe(0);
    expect(b.build.releasedQueued()).toEqual([]);
    expect(buildCount(b, id)).toBe(1);
  });
});

describe("放行只认比上一次 build 新的估价（7.2 审查 S2-H1 / S2-M1）", () => {
  it("估价与它放行的 build 同一毫秒：也不算放行（不靠时间差碰运气）", async () => {
    const b = await boot();
    b.setBuild(new Error("第一次炸了"));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "第一次失败");
    const est = b.estimate.currentEstimate(id) as { createdAt: string };
    b.db().prepare("UPDATE builds SET created_at = ? WHERE production_id = ?").run(est.createdAt, id);
    b.db().prepare("UPDATE productions SET status = 'queued' WHERE id = ?").run(id);
    expect(b.build.releasedQueued()).toEqual([]);
    expect(b.build.pumpBuilds()).toBe(0);
  });

  it("重试后还没估完进程就退了：重启补估把它捡回来（最新估价不晚于上一次 build）", async () => {
    const b = await boot();
    b.setBuild(new Error("第一次炸了"));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "第一次失败");
    b.db().prepare("UPDATE productions SET status = 'queued' WHERE id = ?").run(id);
    expect(b.estimate.unestimatedQueued()).toEqual([id]);
    await b.estimate.estimateProduction(id);
    expect(b.estimate.unestimatedQueued()).toEqual([]);
  });
});

describe("批次已花算上没出成的尝试", () => {
  it("批次里一条已提交却失败的 build（估 $0.8）：这条 $0.5 再估时按 0.8 + 0.5 > 批次限额 $1 停下", async () => {
    const b = await boot();
    b.rates.upsertRate({ capability: RENDER, unit: "request", usd: 0.5 });
    b.setPlan(LOCAL_PLAN);
    const now = new Date().toISOString();
    const d = b.db();
    d.prepare("INSERT INTO batches (id, template_id, budget_usd, created_at) VALUES ('b1', ?, 1, ?)").run(
      b.templateId,
      now,
    );
    d.prepare(
      `INSERT INTO productions (id, template_id, kind, batch_id, version, run_path, status, created_at, updated_at)
       VALUES ('v1', ?, 'variant', 'b1', 1, 'reference.svrun', 'queued', ?, ?)`,
    ).run(b.templateId, now, now);
    // 不计入时：只看数字 0.5 ≤ 1，放行
    expect(await b.estimate.estimateProduction("v1")).toMatchObject({ totalUsd: 0.5, decision: "auto" });
    await until(() => productionStatus(b, "v1") === "done", "先出完一次");
    d.prepare("DELETE FROM builds WHERE production_id = 'v1'").run();
    d.prepare(
      `INSERT INTO builds (id, production_id, hypit_build_id, estimate_usd, status, created_at)
       VALUES ('bx', 'v1', 'bld_x', 0.8, 'failed', ?)`,
    ).run(now);
    d.prepare("UPDATE productions SET status = 'queued' WHERE id = 'v1'").run();
    expect(await b.estimate.estimateProduction("v1")).toMatchObject({
      totalUsd: 0.5,
      decision: "confirm",
      reasons: ["over_batch_limit"],
    });
  });
});
