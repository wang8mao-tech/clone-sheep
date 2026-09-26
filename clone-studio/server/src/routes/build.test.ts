import { describe, expect, it } from "vitest";
import { boot, BUILD_OK, until, useCloneSandbox, type Booted } from "../services/clone-test-kit.js";

/** 出片接口：看进度 / 结果、手动起片、取消、重试 */

useCloneSandbox();

const LOCAL_PLAN = {
  format: "hypit.cli-plan@1",
  ok: true,
  providerRequestCount: 0,
  unresolvedRequestCount: 0,
  unsupportedRequestCount: 0,
  providers: [
    {
      request: "r1",
      capability: "@hypit/render-hyperframes@1#render-visual",
      status: "resolved",
      endpoint: "hyperframes.local",
      pricing: { kind: "local" },
    },
  ],
  needs: [{ request: "r1", summary: { fields: { startFrame: 0, endFrameExclusive: 900, frameRate: "30/1" } } }],
  preflight: { ok: true, diagnostics: [] },
};

async function app() {
  const Fastify = (await import("fastify")).default;
  const { buildRoutes } = await import("./build.js");
  const server = Fastify();
  await server.register(buildRoutes);
  return server;
}

async function released(b: Booted): Promise<string> {
  b.setPlan(LOCAL_PLAN);
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

describe("GET /api/productions/:id/build", () => {
  it("没出过片 404；出完后给 build 记录（含导出路径、估价）", async () => {
    const b = await boot();
    const server = await app();
    expect((await server.inject({ url: "/api/productions/nope/build" })).statusCode).toBe(404);
    b.setBuild({ lines: [], json: BUILD_OK });
    const id = await released(b);
    await until(() => statusOf(b, id) === "done", "出片完成");
    const res = await server.inject({ url: `/api/productions/${id}/build` });
    expect(res.statusCode).toBe(200);
    expect(res.json().build).toMatchObject({ status: "done", hypitBuildId: "bld_test_0001", estimateUsd: 0 });
    await server.close();
  });
});

describe("取消与重试", () => {
  it("运行中取消：200 且状态已取消；不在跑的取消 409；重试失败的 → 重新起片", async () => {
    const b = await boot();
    b.setBuild(
      (options) =>
        new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(new Error("aborted")))),
    );
    const id = await released(b);
    await until(() => statusOf(b, id) === "building", "渲染中");
    const server = await app();
    const cancel = await server.inject({ method: "POST", url: `/api/productions/${id}/build/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().build).toMatchObject({ status: "cancelled", hypitBuildId: "bld_test_0001" });
    await until(() => statusOf(b, id) === "failed", "回到失败（可重试）");
    const again = await server.inject({ method: "POST", url: `/api/productions/${id}/build/cancel` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("NOT_RUNNING");

    b.setBuild({ lines: [], json: BUILD_OK });
    const retry = await server.inject({ method: "POST", url: `/api/productions/${id}/build/retry` });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ queued: true });
    await until(() => statusOf(b, id) === "done", "重试出完");
    const notRetryable = await server.inject({ method: "POST", url: `/api/productions/${id}/build/retry` });
    expect(notRetryable.statusCode).toBe(409);
    await server.close();
  });

  it("手动起片：不在排队的 409 NOT_QUEUED；排队但没估过价的 409 NOT_RELEASED；不存在 404", async () => {
    const b = await boot();
    b.rates.upsertRate({ capability: "@hypit/render-hyperframes@1#render-visual", unit: "second", usd: 0.1 });
    const id = await released(b);
    expect(statusOf(b, id)).toBe("awaiting_cost_confirm");
    const server = await app();
    expect((await server.inject({ method: "POST", url: "/api/productions/nope/build" })).statusCode).toBe(404);
    // 排队里、还没有估价结论的（估价还在跑）：闸门没过，不能手动起
    const now = new Date().toISOString();
    b.db()
      .prepare(
        `INSERT INTO productions (id, template_id, kind, version, run_path, status, created_at, updated_at)
         VALUES ('unestimated', ?, 'variant', 1, 'reference.svrun', 'queued', ?, ?)`,
      )
      .run(b.templateId, now, now);
    const gated = await server.inject({ method: "POST", url: "/api/productions/unestimated/build" });
    expect(gated.statusCode).toBe(409);
    expect(gated.json().error.code).toBe("NOT_RELEASED");
    // 排队里、结论是「要确认」但还没人确认（状态被手工改回 queued 之类）：同样没放行
    b.db()
      .prepare(
        `INSERT INTO productions (id, template_id, kind, version, run_path, status, created_at, updated_at)
         VALUES ('unconfirmed', ?, 'variant', 1, 'reference.svrun', 'queued', ?, ?)`,
      )
      .run(b.templateId, now, now);
    b.db()
      .prepare(
        `INSERT INTO estimates (id, production_id, kind, total_usd, lines_json, decision, reasons_json, created_at)
         VALUES ('e-unconfirmed', 'unconfirmed', 'ok', 2.1, '[]', 'confirm', '["over_item_limit"]', ?)`,
      )
      .run(now);
    const unconfirmed = await server.inject({ method: "POST", url: "/api/productions/unconfirmed/build" });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json().error.code).toBe("NOT_RELEASED");
    // 待确认的不在 queued：NOT_QUEUED；确认之后闸门放行、自动起片，手动再起就是 BUILD_IN_FLIGHT 或 NOT_QUEUED
    const res = await server.inject({ method: "POST", url: `/api/productions/${id}/build` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NOT_QUEUED");
    await server.close();
  });
});
