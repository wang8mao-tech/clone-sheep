import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { boot, until, useCloneSandbox, type Booted } from "./clone-test-kit.js";

/**
 * 估价与闸门的编排（REQ-006）：判据通过后自动估、限额内 auto / 超限 confirm / 未解析 blocked、
 * 估价拿不到（plan 跑不起来、费率缺项）按超限、确认花费、改费率后重估、重启补估。
 * hypit 的 plan / pricing 是假的（形状照 Phase 6 实跑），库和文件是真的。
 */

useCloneSandbox();

const RENDER = "@hypit/render-hyperframes@1#render-visual";
const SEEDANCE = "@hypit/seedance@2#generate-video";

/** 一条本地渲染 + 一条 TokenDance 生视频（5 秒）的 plan */
function plan(over: Record<string, unknown> = {}) {
  return {
    format: "hypit.cli-plan@1",
    ok: true,
    providerRequestCount: 1,
    unresolvedRequestCount: 0,
    unsupportedRequestCount: 0,
    providers: [
      {
        request: "r1",
        capability: RENDER,
        status: "resolved",
        endpoint: "hyperframes.local",
        pricing: { kind: "local" },
      },
      {
        request: "r2",
        capability: SEEDANCE,
        status: "resolved",
        endpoint: "tokendance.default",
        pricing: { kind: "page", url: "https://tokendance.space/models" },
      },
    ],
    needs: [
      { request: "r1", summary: { fields: { startFrame: 0, endFrameExclusive: 900, frameRate: "30/1" } } },
      { request: "r2", summary: { fields: { duration: 5 } } },
    ],
    preflight: { ok: true, diagnostics: [] },
    ...over,
  };
}

/** 判据通过 → 复刻片排队 → 自动估价；返回复刻片 id */
async function replicaReady(b: Booted): Promise<string> {
  b.setStatus("cloning");
  b.clone.startClone(b.templateId);
  b.writeProducts();
  await b.finishRun();
  await until(() => b.clone.latestReplica(b.templateId) !== undefined, "复刻片建出来");
  const replica = b.clone.latestReplica(b.templateId) as { id: string };
  await until(() => b.estimate.currentEstimate(replica.id) !== undefined, "估价落库");
  return replica.id;
}

const statusOf = (b: Booted, id: string) =>
  (b.db().prepare("SELECT status FROM productions WHERE id = ?").get(id) as { status: string }).status;

describe("判据通过后自动估价", () => {
  it("全是本地能力：$0，限额内自动放行，复刻片留在排队等出片；plan / pricing 都记进 hypit_calls", async () => {
    const b = await boot();
    b.setPlan(plan({ providerRequestCount: 0, providers: [plan().providers[0]], needs: [plan().needs[0]] }));
    const id = await replicaReady(b);

    const est = b.estimate.currentEstimate(id);
    expect(est).toMatchObject({ kind: "ok", totalUsd: 0, decision: "auto", reasons: [] });
    expect(statusOf(b, id)).toBe("queued");
    const calls = b.hypitCalls.filter((c) => c[0] === "plan" || c[0] === "pricing");
    expect(calls.map((c) => c[0])).toEqual(["plan", "pricing"]);
    // 显式 --workspace，且指定重写过的 Runtime Profile
    expect(calls[0]).toEqual([
      "plan",
      "reference.svrun",
      "--runtime",
      "hypit.runtime.json",
      "--workspace",
      b.workspace,
      "--json",
    ]);
  });

  it("估价前重写 Runtime Profile：Agent 改过的路由被覆盖回当前设置", async () => {
    const b = await boot();
    const profile = path.join(b.workspace, "hypit.runtime.json");
    const tampered = { format: "hypit.runtime-local@1", endpoints: { evil: { use: "x" } }, bindings: {} };
    (await import("node:fs")).writeFileSync(profile, JSON.stringify(tampered), "utf8");
    await replicaReady(b);
    const written = JSON.parse(readFileSync(profile, "utf8")) as { endpoints: Record<string, unknown> };
    expect(written.endpoints.evil).toBeUndefined();
    expect(written.endpoints["hyperframes.local"]).toBeDefined();
  });

  it("费率表缺付费能力的单价：估价拿不到，按超限停在「待确认花费」，价格页链接带出", async () => {
    const b = await boot();
    b.setPlan(plan());
    const id = await replicaReady(b);
    const est = b.estimate.currentEstimate(id);
    expect(est).toMatchObject({ kind: "ok", totalUsd: null, decision: "confirm", reasons: ["estimate_unknown"] });
    expect(est?.pricingUrls).toEqual(["https://tokendance.space/models"]);
    expect(statusOf(b, id)).toBe("awaiting_cost_confirm");
  });

  it("有费率、$0.5 在单条限额 $1.5 内：auto", async () => {
    const b = await boot();
    b.rates.upsertRate({ capability: SEEDANCE, unit: "second", usd: 0.1 });
    b.setPlan(plan());
    const id = await replicaReady(b);
    expect(b.estimate.currentEstimate(id)).toMatchObject({ totalUsd: 0.5, decision: "auto" });
  });

  it("AC-018：估价 $2.1 超过单条限额：待确认花费；确认后回到排队（AC-018 的 build 由 6.4 接）", async () => {
    const b = await boot();
    b.rates.upsertRate({ capability: SEEDANCE, unit: "second", usd: 0.42 });
    b.setPlan(plan());
    const id = await replicaReady(b);
    expect(b.estimate.currentEstimate(id)).toMatchObject({
      totalUsd: 2.1,
      decision: "confirm",
      reasons: ["over_item_limit"],
    });
    expect(statusOf(b, id)).toBe("awaiting_cost_confirm");

    const confirmed = b.estimate.confirmCost(id);
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(statusOf(b, id)).toBe("queued");
    // 再确认一次是幂等的；auto 的那种不能确认
    expect(b.estimate.confirmCost(id).confirmedAt).toBe(confirmed.confirmedAt);
  });

  it("有未解析请求：不出片，标失败并写明缺哪种能力", async () => {
    const b = await boot();
    b.setPlan(
      plan({
        unresolvedRequestCount: 1,
        providers: [{ request: "r3", capability: "@hypit/tts@1#speak", status: "unresolved" }],
      }),
    );
    const id = await replicaReady(b);
    expect(b.estimate.currentEstimate(id)).toMatchObject({
      kind: "blocked",
      decision: "blocked",
      reason: "有请求没有可用的 Provider：@hypit/tts@1#speak",
    });
    expect(statusOf(b, id)).toBe("failed");
    expect(() => b.estimate.confirmCost(id)).toThrow(/不需要确认花费/);
  });

  it("plan 跑不起来：原文记下，按拿不到处理（待确认），不让复刻片卡在排队", async () => {
    const b = await boot();
    const { HypitError } = await import("../hypit/cli.js");
    b.setPlan(new HypitError("RUNTIME_MISSING", "No Runtime Profile is selected", "hypit runtime use"));
    const id = await replicaReady(b);
    const est = b.estimate.currentEstimate(id);
    expect(est).toMatchObject({ totalUsd: null, decision: "confirm", reasons: ["estimate_unknown"] });
    expect(est?.error).toContain("No Runtime Profile is selected");
  });

  it("pricing 失败不影响估价", async () => {
    const b = await boot();
    b.setPlan(plan({ providerRequestCount: 0, providers: [plan().providers[0]], needs: [plan().needs[0]] }));
    b.setPricing(new Error("网断了"));
    const id = await replicaReady(b);
    expect(b.estimate.currentEstimate(id)).toMatchObject({ totalUsd: 0, decision: "auto" });
  });
});

describe("重估与重启", () => {
  it("出片失败（有 build 记录）的不能重新估价，要走「重试出片」", async () => {
    const b = await boot();
    b.setPlan(plan({ providerRequestCount: 0, providers: [plan().providers[0]], needs: [plan().needs[0]] }));
    const id = await replicaReady(b);
    const now = new Date().toISOString();
    b.db()
      .prepare("INSERT INTO builds (id, production_id, status, created_at) VALUES ('bld1', ?, 'failed', ?)")
      .run(id, now);
    b.db().prepare("UPDATE productions SET status = 'failed' WHERE id = ?").run(id);
    await expect(b.estimate.estimateProduction(id)).rejects.toMatchObject({ code: "NOT_ESTIMABLE" });
  });

  it("改了费率表再估一次：新结论覆盖旧的", async () => {
    const b = await boot();
    b.setPlan(plan());
    const id = await replicaReady(b);
    expect(b.estimate.currentEstimate(id)?.decision).toBe("confirm");
    b.rates.upsertRate({ capability: SEEDANCE, unit: "request", usd: 0.3 });
    await b.estimate.estimateProduction(id);
    expect(b.estimate.currentEstimate(id)).toMatchObject({ totalUsd: 0.3, decision: "auto" });
    expect(statusOf(b, id)).toBe("queued");
  });

  it("重启：排队中没估过价的复刻片补估一次；估过的不重复估", async () => {
    const b = await boot({ register: false });
    b.setPlan(plan({ providerRequestCount: 0, providers: [plan().providers[0]], needs: [plan().needs[0]] }));
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts();
    const jobId = await b.finishRun();
    await b.clone.verifyClone(b.store.requireJob(jobId));
    const replica = b.clone.latestReplica(b.templateId) as { id: string };
    await until(() => b.estimate.currentEstimate(replica.id) !== undefined, "估价落库");
    // 模拟「进程在估价落库前退出」：把结论删掉，复刻片留在排队里
    b.db().prepare("DELETE FROM estimates WHERE production_id = ?").run(replica.id);
    expect(b.estimate.unestimatedQueued()).toEqual([replica.id]);
    const before = b.hypitCalls.filter((c) => c[0] === "plan").length;

    b.register();
    await until(() => b.estimate.currentEstimate(replica.id) !== undefined, "补估落库");
    expect(b.hypitCalls.filter((c) => c[0] === "plan").length).toBe(before + 1);

    // 再注册一次（相当于再重启）：已经估过，不再跑 plan
    b.register();
    await new Promise((r) => setTimeout(r, 50));
    expect(b.hypitCalls.filter((c) => c[0] === "plan").length).toBe(before + 1);
  });

  it("AC-019（编排层）：批次里前一条因批次限额停下、还没确认，后一条哪怕便宜也停", async () => {
    const b = await boot();
    b.rates.upsertRate({ capability: SEEDANCE, unit: "second", usd: 0.1 });
    b.setPlan(plan());
    const now = new Date().toISOString();
    const d = b.db();
    // 批次限额 $15：已花靠现算（v0 已放行 $14.8），不靠 spent_usd 字段
    d.prepare("INSERT INTO batches (id, template_id, budget_usd, created_at) VALUES ('b1', ?, 15, ?)").run(
      b.templateId,
      now,
    );
    d.prepare(
      `INSERT INTO productions (id, template_id, kind, batch_id, version, run_path, status, created_at, updated_at)
       VALUES ('v0', ?, 'variant', 'b1', 1, 'reference.svrun', 'queued', '2026-09-23T09:00:00.000Z', '2026-09-23T09:00:00.000Z')`,
    ).run(b.templateId);
    d.prepare(
      `INSERT INTO estimates (id, production_id, kind, total_usd, lines_json, decision, reasons_json, created_at)
       VALUES ('e0', 'v0', 'ok', 14.8, '[]', 'auto', '[]', '2026-09-23T09:00:01.000Z')`,
    ).run();
    // v1 比 v2 早：AC-019 的「之后」按建立时间算
    for (const [id, at] of [
      ["v1", "2026-09-23T10:00:00.000Z"],
      ["v2", "2026-09-23T10:00:01.000Z"],
    ] as const) {
      d.prepare(
        `INSERT INTO productions (id, template_id, kind, batch_id, version, run_path, status, created_at, updated_at)
         VALUES (?, ?, 'variant', 'b1', 1, 'reference.svrun', 'queued', ?, ?)`,
      ).run(id, b.templateId, at, at);
    }
    // v1：$0.5，已花 14.8 + 0.5 > 15 → 批次超限停下
    expect(await b.estimate.estimateProduction("v1")).toMatchObject({
      decision: "confirm",
      reasons: ["over_batch_limit"],
    });
    // v2：同样 $0.5；如果只看数字 14.8 + 0.5 也超，这里改成便宜到能过的价再验「之后全部停」
    b.rates.upsertRate({ capability: SEEDANCE, unit: "second", usd: 0.02 });
    expect(await b.estimate.estimateProduction("v2")).toMatchObject({ decision: "confirm", reasons: ["batch_halted"] });
    // 重估更早的 v1：后面 v2 的 batch_halted 挡不到它，它自己只按数字判（0.1 ≤ 剩余 0.2）
    expect(await b.estimate.estimateProduction("v1")).toMatchObject({ decision: "auto" });
    // 让 v1 回到因批次超限停下的状态，再验「v1 被作废后不再挡 v2」「v1 确认后不再挡 v2」
    b.rates.upsertRate({ capability: SEEDANCE, unit: "second", usd: 0.1 });
    expect(await b.estimate.estimateProduction("v1")).toMatchObject({
      decision: "confirm",
      reasons: ["over_batch_limit"],
    });
    b.rates.upsertRate({ capability: SEEDANCE, unit: "second", usd: 0.02 });
    expect(await b.estimate.estimateProduction("v2")).toMatchObject({ decision: "confirm", reasons: ["batch_halted"] });
    d.prepare("UPDATE productions SET status = 'cancelled' WHERE id = 'v1'").run();
    expect(await b.estimate.estimateProduction("v2")).toMatchObject({ decision: "auto" });
  });

  it("批次已花现算：两条 auto 累计后第三条超限停下；作废的那条不计入", async () => {
    const b = await boot();
    b.rates.upsertRate({ capability: SEEDANCE, unit: "second", usd: 1.2 });
    b.setPlan(plan());
    const d = b.db();
    // 单条限额放宽到 $10：这条验的是批次累计，别让单条限额先挡住
    d.prepare("UPDATE settings SET per_item_limit_usd = 10 WHERE id = 1").run();
    // 批次自己的 budget $10（比设置的批次限额 $15 严）：以 budget 为准
    d.prepare("INSERT INTO batches (id, template_id, budget_usd, created_at) VALUES ('b2', ?, 10, ?)").run(
      b.templateId,
      new Date().toISOString(),
    );
    for (const [id, at] of [
      ["w1", "2026-09-23T10:00:00.000Z"],
      ["w2", "2026-09-23T10:00:01.000Z"],
      ["w3", "2026-09-23T10:00:02.000Z"],
    ] as const) {
      d.prepare(
        `INSERT INTO productions (id, template_id, kind, batch_id, version, run_path, status, created_at, updated_at)
         VALUES (?, ?, 'variant', 'b2', 1, 'reference.svrun', 'queued', ?, ?)`,
      ).run(id, b.templateId, at, at);
    }
    // 每条 $6：w1 放行（6 ≤ 10），w2 超批次 budget（12 > 10；按设置的 $15 本来能过），w3 跟着停
    expect(await b.estimate.estimateProduction("w1")).toMatchObject({ totalUsd: 6, decision: "auto" });
    expect(await b.estimate.estimateProduction("w2")).toMatchObject({
      decision: "confirm",
      reasons: ["over_batch_limit"],
    });
    // w3：数字上也超（6 + 6 > 10），并且前面的 w2 还停着 → 两个原因都列
    expect(await b.estimate.estimateProduction("w3")).toMatchObject({
      decision: "confirm",
      reasons: ["over_batch_limit", "batch_halted"],
    });
    // w1 作废后已花归零，w2 再估就过了
    d.prepare("UPDATE productions SET status = 'cancelled' WHERE id = 'w1'").run();
    expect(await b.estimate.estimateProduction("w2")).toMatchObject({ decision: "auto" });
  });

  it("估价跑到一半复刻片被作废（换参考视频）：结论照记，状态不从「已取消」拉回来，事件里 decision 为 null", async () => {
    const b = await boot();
    const published: unknown[] = [];
    const { sseHub } = await import("../lib/sse.js");
    vi.spyOn(sseHub, "publish").mockImplementation((topic, event, data) => {
      if (event === "estimate") published.push(data);
      return { id: 0, topic, event, data };
    });
    let release: (v: Record<string, unknown>) => void = () => undefined;
    b.setPlan(() => new Promise((resolve) => (release = resolve)));
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts();
    await b.finishRun();
    await until(() => b.hypitCalls.some((c) => c[0] === "plan"), "plan 开跑");
    const replica = b.clone.latestReplica(b.templateId) as { id: string };
    // 换参考视频：复刻片作废
    b.db().prepare("UPDATE productions SET status = 'cancelled' WHERE id = ?").run(replica.id);

    release(plan({ providerRequestCount: 0, providers: [plan().providers[0]], needs: [plan().needs[0]] }));
    await until(() => b.estimate.currentEstimate(replica.id) !== undefined, "结论落库");
    expect(statusOf(b, replica.id)).toBe("cancelled");
    expect(published.at(-1)).toMatchObject({ productionId: replica.id, decision: null });
    // 作废的不能确认，也不能再估
    expect(() => b.estimate.confirmCost(replica.id)).toThrow(/不需要确认花费|不在待确认/);
    await expect(b.estimate.estimateProduction(replica.id)).rejects.toMatchObject({ code: "NOT_ESTIMABLE" });
  });

  it("待确认的复刻片被作废后再点确认：409，不回到排队", async () => {
    const b = await boot();
    b.setPlan(plan());
    const id = await replicaReady(b);
    expect(statusOf(b, id)).toBe("awaiting_cost_confirm");
    b.db().prepare("UPDATE productions SET status = 'cancelled' WHERE id = ?").run(id);
    expect(() => b.estimate.confirmCost(id)).toThrow(/不在待确认花费状态/);
    expect(statusOf(b, id)).toBe("cancelled");
  });

  it("同一条不并发估两遍：第二次调用直接 409，补估清单也跳过正在估的", async () => {
    const b = await boot();
    let release: (v: Record<string, unknown>) => void = () => undefined;
    b.setPlan(() => new Promise((resolve) => (release = resolve)));
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts();
    await b.finishRun();
    await until(() => b.hypitCalls.some((c) => c[0] === "plan"), "plan 开跑");
    const replica = b.clone.latestReplica(b.templateId) as { id: string };
    await expect(b.estimate.estimateProduction(replica.id)).rejects.toMatchObject({ code: "ESTIMATE_IN_FLIGHT" });
    expect(b.estimate.unestimatedQueued()).toEqual([]);
    release(plan({ providerRequestCount: 0, providers: [plan().providers[0]], needs: [plan().needs[0]] }));
    await until(() => b.estimate.currentEstimate(replica.id) !== undefined, "结论落库");
    expect(b.hypitCalls.filter((c) => c[0] === "plan")).toHaveLength(1);
  });
});
