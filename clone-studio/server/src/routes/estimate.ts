import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { sseHub } from "../lib/sse.js";
import { confirmCost, currentEstimate, estimateProduction, EstimateError } from "../services/estimate-run.js";
import { deleteRate, listRates, upsertRate } from "../services/rates.js";
import { archiveErrorHandler } from "./errors.js";

/** 费率表（设置页可编辑）与出片单位的估价 / 确认花费（REQ-006） */

const RateBody = z.object({
  capability: z.string().trim().min(1).max(200),
  endpoint: z.string().max(100).nullable().optional(),
  unit: z.enum(["request", "second"]),
  usd: z.number().min(0).max(10_000),
  note: z.string().max(500).nullable().optional(),
});

export async function estimateRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof EstimateError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    return archiveErrorHandler(error, request, reply);
  });

  app.get("/api/settings/rates", async () => ({ rates: listRates() }));

  app.put("/api/settings/rates", async (request, reply) => {
    const parsed = RateBody.safeParse(request.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return reply.status(400).send({ error: { code: "INVALID_BODY", message: first?.message ?? "费率不合法" } });
    }
    const rate = upsertRate(parsed.data);
    sseHub.publish("global", "settings", { rates: true });
    return { rate };
  });

  app.delete("/api/settings/rates/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || !deleteRate(id)) {
      return reply.status(404).send({ error: { code: "RATE_NOT_FOUND", message: "这条费率不存在" } });
    }
    sseHub.publish("global", "settings", { rates: true });
    return { ok: true };
  });

  app.get("/api/productions/:id/estimate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const estimate = currentEstimate(id);
    if (!estimate) return reply.status(404).send({ error: { code: "NO_ESTIMATE", message: "这条还没有估价" } });
    return { estimate };
  });

  /** 重新估价：改了费率表或 Runtime Profile 之后用。只对没出片的 */
  app.post("/api/productions/:id/estimate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db().prepare("SELECT status FROM productions WHERE id = ?").get(id) as { status: string } | undefined;
    if (!row) return reply.status(404).send({ error: { code: "PRODUCTION_NOT_FOUND", message: "出片单位不存在" } });
    // 状态能不能估由 estimateProduction 自己把关（已在出片 / 已出完 / 已作废 → 409 NOT_ESTIMABLE）
    return { estimate: await estimateProduction(id) };
  });

  app.post("/api/productions/:id/confirm-cost", async (request) => {
    const { id } = request.params as { id: string };
    return { estimate: confirmCost(id) };
  });
}
