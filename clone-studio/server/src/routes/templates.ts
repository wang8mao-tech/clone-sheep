import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  presentClient,
  presentTemplate,
  renameTemplate,
  requireClient,
  requireTemplate,
  templateStats,
} from "../services/archive.js";
import { deleteTemplate, templateImpact } from "../services/deletion.js";
import { pipelineStatus } from "../services/evidence-rules.js";
import { listSteps } from "../services/evidence-store.js";
import { sseHub } from "../lib/sse.js";
import { archiveErrorHandler } from "./errors.js";

const NameBody = z.object({ name: z.string() });

export async function templateRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(archiveErrorHandler);

  /**
   * 模板页页头需要的东西：面包屑上的客户名、模板名、累计花费。
   * evidenceStatus 给步骤条判断 failed 落在哪一步：证据准备没过就是倒在 ①参考，
   * 过了才是倒在后面。只看源视频在不在会把探测/转写/抽帧的失败都算到 ②复刻头上
   * （Task 4.4 审查 HIGH，实测）
   */
  app.get("/api/templates/:id", async (request) => {
    const { id } = request.params as { id: string };
    const template = requireTemplate(id);
    return {
      ...presentTemplate(template),
      client: presentClient(requireClient(template.client_id)),
      stats: templateStats(template),
      evidenceStatus: pipelineStatus(listSteps(id)),
    };
  });

  app.patch("/api/templates/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = NameBody.parse(request.body);
    const template = renameTemplate(id, body.name);
    sseHub.publish("global", "archive", { kind: "template", action: "renamed", id });
    return presentTemplate(template);
  });

  app.get("/api/templates/:id/deletion-impact", async (request) => {
    const { id } = request.params as { id: string };
    return templateImpact(id);
  });

  app.delete("/api/templates/:id", async (request) => {
    const { id } = request.params as { id: string };
    const impact = await deleteTemplate(id);
    sseHub.publish("global", "archive", { kind: "template", action: "deleted", id });
    return impact;
  });
}
