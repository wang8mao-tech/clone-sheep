import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTemplate } from "../services/archive.js";
import { EVIDENCE_STEPS } from "../services/evidence-rules.js";
import { evidenceState, retryEvidence, startEvidence, EvidenceError } from "../services/evidence.js";
import { archiveErrorHandler } from "./errors.js";

/**
 * REQ-002 输入表的语言枚举：WhisperX 的对齐语言。多给几个常见的，
 * 不在表里的一律拒——拒绝比把一个它不认的码原样拼进 --language 强。
 */
const LANGUAGES = ["zh", "en", "ja", "ko", "es", "fr", "de", "ru", "pt", "it", "ar", "hi"] as const;

/** REQ-002 输入表：语言必填默认 zh；链接限 http/https；复刻备注 ≤1000 字 */
const StartBody = z
  .object({
    language: z.enum(LANGUAGES).default("zh"),
    note: z.string().max(1000).optional(),
    url: z
      .string()
      .url()
      // z.string().url() 会放行 file: / javascript: / data:。file:// 交给
      // yt-dlp 就是第二个任意文件读取入口，Spec 输入表写的就是 http/https
      .refine((u) => ["http:", "https:"].includes(new URL(u).protocol), {
        message: "只支持 http/https 链接",
      })
      .optional(),
    /** 上传接口（Task 4.3）落盘后把临时路径交过来 */
    uploadPath: z.string().min(1).optional(),
    /** Agent 模型档案（REQ-010、CMP-010）；不给用默认档案 */
    profileId: z.string().min(1).optional(),
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
    const parsed = StartBody.safeParse(request.body);
    if (!parsed.success) {
      // 把第一条 issue 的原文带出来。统一压成「请求参数不合法」的话，前端读
      // error.message 只会看到一句没信息量的废话
      const first = parsed.error.issues[0];
      throw new EvidenceError("INVALID_BODY", first?.message ?? "请求参数不合法", 400);
    }
    const body = parsed.data;
    return startEvidence({
      templateId: id,
      source: body.url ? { kind: "url", url: body.url } : { kind: "file", path: body.uploadPath as string },
      language: body.language,
      ...(body.note ? { note: body.note } : {}),
      ...(body.profileId ? { profileId: body.profileId } : {}),
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
