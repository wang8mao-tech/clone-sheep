import { describe, expect, it } from "vitest";
import { boot, until, useCloneSandbox, type Booted } from "../services/clone-test-kit.js";

/** 费率表接口（设置页可编辑）与出片单位的估价 / 确认花费接口（REQ-006） */

useCloneSandbox();

async function app() {
  const Fastify = (await import("fastify")).default;
  const { estimateRoutes } = await import("./estimate.js");
  const server = Fastify();
  await server.register(estimateRoutes);
  return server;
}

const PAID_PLAN = {
  format: "hypit.cli-plan@1",
  ok: true,
  providerRequestCount: 1,
  unresolvedRequestCount: 0,
  unsupportedRequestCount: 0,
  providers: [
    {
      request: "r2",
      capability: "@hypit/seedance@2#generate-video",
      status: "resolved",
      endpoint: "tokendance.default",
      pricing: { kind: "page", url: "https://tokendance.space/models" },
    },
  ],
  needs: [{ request: "r2", summary: { fields: { duration: 5 } } }],
  preflight: { ok: true, diagnostics: [] },
};

const productionStatus = (b: Booted, id: string) =>
  (b.db().prepare("SELECT status FROM productions WHERE id = ?").get(id) as { status: string }).status;

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

describe("费率表", () => {
  it("增、改（同能力覆盖）、列、删", async () => {
    await boot();
    const server = await app();
    const put = (body: Record<string, unknown>) =>
      server.inject({ method: "PUT", url: "/api/settings/rates", payload: body });
    const first = await put({
      capability: "@hypit/seedance@2#generate-video",
      unit: "second",
      usd: 0.1,
      note: "官网价",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().rate).toMatchObject({
      capability: "@hypit/seedance@2#generate-video",
      endpoint: null,
      usd: 0.1,
    });

    const again = await put({ capability: "@hypit/seedance@2#generate-video", unit: "request", usd: 0.3 });
    expect(again.json().rate).toMatchObject({ id: first.json().rate.id, unit: "request", usd: 0.3 });
    // 指定 Endpoint 的是另一行
    await put({
      capability: "@hypit/seedance@2#generate-video",
      endpoint: "tokendance.default",
      unit: "request",
      usd: 0.28,
    });
    const list = (await server.inject({ url: "/api/settings/rates" })).json().rates as Array<{ id: number }>;
    expect(list).toHaveLength(2);

    expect((await server.inject({ method: "DELETE", url: `/api/settings/rates/${list[0]?.id}` })).statusCode).toBe(200);
    expect((await server.inject({ method: "DELETE", url: "/api/settings/rates/9999" })).statusCode).toBe(404);
    expect((await server.inject({ url: "/api/settings/rates" })).json().rates).toHaveLength(1);
    await server.close();
  });

  it("不合法的费率：400 带原因", async () => {
    await boot();
    const server = await app();
    const res = await server.inject({
      method: "PUT",
      url: "/api/settings/rates",
      payload: { capability: "", unit: "hour", usd: -1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_BODY");
    await server.close();
  });
});

describe("估价与确认", () => {
  it("读估价；待确认的点确认后放行、执行器接手出片；出完的不能再估", async () => {
    const b = await boot();
    b.setPlan(PAID_PLAN);
    const id = await replicaReady(b);
    const server = await app();
    const got = await server.inject({ url: `/api/productions/${id}/estimate` });
    expect(got.json().estimate).toMatchObject({ decision: "confirm", reasons: ["estimate_unknown"] });

    const confirmed = await server.inject({ method: "POST", url: `/api/productions/${id}/confirm-cost` });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().estimate.confirmedAt).toBeTruthy();
    // 确认即放行（6.4）：假 build 立刻成功
    await until(() => productionStatus(b, id) === "done", "确认后出片完成");

    // 出完的不能重估
    b.rates.upsertRate({ capability: "@hypit/seedance@2#generate-video", unit: "second", usd: 0.1 });
    const re = await server.inject({ method: "POST", url: `/api/productions/${id}/estimate` });
    expect(re.statusCode).toBe(409);
    expect(re.json().error.code).toBe("NOT_ESTIMABLE");
    await server.close();
  });

  it("auto 的不能确认：409 NOT_AWAITING_CONFIRM", async () => {
    const b = await boot();
    b.setPlan(PAID_PLAN);
    b.rates.upsertRate({ capability: "@hypit/seedance@2#generate-video", unit: "second", usd: 0.1 });
    const id = await replicaReady(b);
    expect(b.estimate.currentEstimate(id)).toMatchObject({ totalUsd: 0.5, decision: "auto" });
    const server = await app();
    const again = await server.inject({ method: "POST", url: `/api/productions/${id}/confirm-cost` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("NOT_AWAITING_CONFIRM");
    await server.close();
  });

  it("没估过的 404；不存在的出片单位 404；已出片的不能重估", async () => {
    const b = await boot();
    const server = await app();
    expect((await server.inject({ url: "/api/productions/nope/estimate" })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: "/api/productions/nope/estimate" })).statusCode).toBe(404);
    const now = new Date().toISOString();
    b.db()
      .prepare(
        `INSERT INTO productions (id, template_id, kind, version, run_path, status, created_at, updated_at)
         VALUES ('done1', ?, 'replica', 1, 'reference.svrun', 'done', ?, ?)`,
      )
      .run(b.templateId, now, now);
    const res = await server.inject({ method: "POST", url: "/api/productions/done1/estimate" });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});
