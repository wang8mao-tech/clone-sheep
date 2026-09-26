import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  cancelVariant,
  listVariants,
  presentVariant,
  requireVariant,
  submitBatch,
  VariantError,
} from "../services/variants.js";
import { archiveErrorHandler } from "./errors.js";

/**
 * 批量 brief 的形状。内容规则（条数、每行字数）只在 service 里判：错误码与逐行明细要一致地回给界面，
 * 这里只管类型；限额的上下界跟着设置走，也在 service 里判
 */
const SubmitBody = z.object({
  briefs: z.string(),
  // 目标语言是枚举（REQ-005 输入表）：只收语言代码（zh、en、pt-BR 这类），界面下拉给的就是这些
  targetLanguage: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/)
    .nullish(),
  note: z.string().nullish(),
  profileId: z.string().nullish(),
  budgetUsd: z.number().nullish(),
});

/** 变体的校验错误要把逐行明细带回去（界面在文本框下逐行标红） */
function variantErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof VariantError) {
    void reply.status(error.status).send({
      error: { code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) },
    });
    return;
  }
  archiveErrorHandler(error, request, reply);
}

/** ④ 变体（REQ-005、SCREEN-006）：批量提交、队列、取消；Agent 模型按档案选（REQ-010） */
export async function variantRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(variantErrorHandler);

  app.get("/api/templates/:id/variants", async (request) => {
    const { id } = request.params as { id: string };
    return listVariants(id);
  });

  app.post("/api/templates/:id/batches", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = SubmitBody.parse(request.body);
    const batch = submitBatch(id, body);
    return reply.status(201).send({ batch });
  });

  app.get("/api/variants/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { variant: presentVariant(requireVariant(id)) };
  });

  app.post("/api/variants/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    return { variant: await cancelVariant(id) };
  });
}
