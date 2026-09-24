import { describe, expect, it } from "vitest";
import { until, useCloneSandbox } from "../services/clone-test-kit.js";
import { bootVariants } from "../services/variant-test-kit.js";

/** ④ 变体接口：批量提交（201 / 逐行明细 / 21 条）、队列、单条、取消、模型清单 */

useCloneSandbox();

async function app() {
  const Fastify = (await import("fastify")).default;
  const { variantRoutes } = await import("./variants.js");
  const server = Fastify();
  await server.register(variantRoutes);
  return server;
}

describe("POST /api/templates/:id/batches", () => {
  it("201 给出批次与变体；队列接口能看到", async () => {
    const b = await bootVariants();
    const server = await app();
    const res = await server.inject({
      method: "POST",
      url: `/api/templates/${b.templateId}/batches`,
      payload: { briefs: "换成手机品牌排行榜\n\n换成汽车品牌排行榜", note: "毒舌", budgetUsd: 5 },
    });
    expect(res.statusCode).toBe(201);
    const batch = res.json().batch;
    expect(batch).toMatchObject({
      note: "毒舌",
      limitUsd: 5,
      variants: [{ name: "换成手机品牌排行榜" }, { name: "换成汽车品牌排行榜" }],
    });
    const list = await server.inject({ url: `/api/templates/${b.templateId}/variants` });
    expect(list.json().batches.map((x: { id: string }) => x.id)).toEqual([batch.id]);
    const one = await server.inject({ url: `/api/variants/${batch.variants[0].id}` });
    expect(one.json().variant).toMatchObject({ id: batch.variants[0].id, brief: "换成手机品牌排行榜" });
    await server.close();
  });

  it("21 行：400，提示一次最多 20 条，带条数；不建任何变体（AC-016）", async () => {
    const b = await bootVariants();
    const server = await app();
    const briefs = Array.from({ length: 21 }, (_, i) => `第 ${i + 1} 条变体 brief`).join("\n");
    const res = await server.inject({
      method: "POST",
      url: `/api/templates/${b.templateId}/batches`,
      payload: { briefs },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: "BRIEFS_TOO_MANY", message: "一次最多 20 条，现在是 21 条", detail: { count: 21, lines: [] } },
    });
    const list = await server.inject({ url: `/api/templates/${b.templateId}/variants` });
    expect(list.json()).toEqual({ batches: [] });
    await server.close();
  });

  it("目标语言只收语言代码（枚举）：乱写的 400", async () => {
    const b = await bootVariants();
    const server = await app();
    const bad = await server.inject({
      method: "POST",
      url: `/api/templates/${b.templateId}/batches`,
      payload: { briefs: "换成手机品牌排行榜", targetLanguage: "请用粤语" },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await server.inject({
      method: "POST",
      url: `/api/templates/${b.templateId}/batches`,
      payload: { briefs: "换成手机品牌排行榜", targetLanguage: "pt-BR" },
    });
    expect(ok.statusCode).toBe(201);
    await server.close();
  });

  it("形状不对 400 INVALID_BODY；没通过验货 409；模板不存在 404", async () => {
    const b = await bootVariants();
    const server = await app();
    const bad = await server.inject({
      method: "POST",
      url: `/api/templates/${b.templateId}/batches`,
      payload: { briefs: 3 },
    });
    expect(bad.json().error.code).toBe("INVALID_BODY");
    b.db().prepare("UPDATE templates SET status = 'awaiting_review' WHERE id = ?").run(b.templateId);
    const locked = await server.inject({
      method: "POST",
      url: `/api/templates/${b.templateId}/batches`,
      payload: { briefs: "换成手机品牌排行榜" },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe("NOT_APPROVED");
    const gone = await server.inject({
      method: "POST",
      url: "/api/templates/nope/batches",
      payload: { briefs: "换成手机排行" },
    });
    expect(gone.statusCode).toBe(404);
    await server.close();
  });
});

describe("取消与模型清单", () => {
  it("POST /api/variants/:id/cancel：记已取消；再取消 409；不存在 404", async () => {
    const b = await bootVariants();
    const id = b.submit(["换成手机品牌排行榜"]).variants[0]?.id as string;
    await until(() => b.calls.length === 1, "会话开跑");
    const server = await app();
    const res = await server.inject({ method: "POST", url: `/api/variants/${id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json().variant.status).toBe("cancelled");
    expect((await server.inject({ method: "POST", url: `/api/variants/${id}/cancel` })).statusCode).toBe(409);
    expect((await server.inject({ method: "POST", url: "/api/variants/nope/cancel" })).statusCode).toBe(404);
    await server.close();
  });

  it("GET /api/agent-models：订阅默认在前，Haiku 标不可选并写原因", async () => {
    await bootVariants();
    const server = await app();
    const models = (await server.inject({ url: "/api/agent-models" })).json().models;
    expect(models[0]).toEqual({ id: null, label: "订阅默认模型", disabledReason: null });
    expect(models.find((m: { id: string }) => m.id?.startsWith("claude-haiku")).disabledReason).toMatch(/check/);
    await server.close();
  });
});
