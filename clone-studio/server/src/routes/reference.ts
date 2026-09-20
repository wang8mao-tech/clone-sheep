import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTemplate } from "../services/archive.js";
import { EVIDENCE_STEPS } from "../services/evidence-rules.js";
import { evidenceState, retryEvidence, startEvidence, EvidenceError } from "../services/evidence.js";
import { archiveErrorHandler } from "./errors.js";

/** REQ-002 输入表：语言必填，默认 zh；复刻备注 ≤1000 字 */
const StartBody = z
  .object({
    language: z.string().min(2).max(16).default("zh"),
    note: z.string().max(1000).optional(),
    url: z.string().url().optional(),
    /** 上传接口（Task 4.3）落盘后把临时路径交过来 */
    uploadPath: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.url) !== Boolean(v.uploadPath), {
    message: "链接与上传文件二选一",
  });

export async function referenceRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(archiveErrorHandler);

  /** 当前的证据清单。刷新页面靠它恢复（REQ-002：刷新后清单状态不丢） */
  app.get("/api/templates/:id/evidence", async (request) => {
    const { id } = request.params as { id: string };
    requireTemplate(id);
    return evidenceState(id);
  });

  app.post("/api/templates/:id/evidence", async (request) => {
    const { id } = request.params as { id: string };
    const body = StartBody.parse(request.body);
    return startEvidence({
      templateId: id,
      source: body.url ? { kind: "url", url: body.url } : { kind: "file", path: body.uploadPath as string },
      language: body.language,
      ...(body.note ? { note: body.note } : {}),
    });
  });

  /** 重试某一步（REQ-002 错误态：哪一步失败停在哪一步，显示错误与「重试此步」） */
  app.post("/api/templates/:id/evidence/:step/retry", async (request) => {
    const { id, step } = request.params as { id: string; step: string };
    if (!(EVIDENCE_STEPS as readonly string[]).includes(step)) {
      throw new EvidenceError("UNKNOWN_STEP", `没有「${step}」这一步。`, 404);
    }
    return retryEvidence(id, step as (typeof EVIDENCE_STEPS)[number]);
  });
}
