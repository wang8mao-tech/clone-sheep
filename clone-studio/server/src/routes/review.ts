import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { present } from "../agent/agent-service.js";
import { latestBuildRow, readProduction } from "../services/build-store.js";
import { attachment } from "../lib/content-disposition.js";
import { outputName, readOutputRow } from "../services/output-store.js";
import { safeFileStem } from "../services/output-zip.js";
import { EvidenceError } from "../services/evidence-types.js";
import { approveReplica, reviewState, reworkReplica } from "../services/review.js";
import { archiveErrorHandler } from "./errors.js";
import { sendVideoFile } from "./video-file.js";

const ApproveBody = z.object({ productionId: z.string().min(1) });
/** 长度只在 service 里判（去掉首尾空白后 1-2000 字），错误码统一是 INVALID_NOTE；这里只管形状 */
const ReworkBody = z.object({ note: z.string() });

/** ③ 验货（REQ-004、SCREEN-005）：历次版本、复刻片播放、通过、打回 */
export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(archiveErrorHandler);

  app.get("/api/templates/:id/review", async (request) => {
    const { id } = request.params as { id: string };
    return reviewState(id);
  });

  app.post("/api/templates/:id/approve", async (request) => {
    const { id } = request.params as { id: string };
    const body = ApproveBody.parse(request.body);
    return approveReplica(id, body.productionId);
  });

  app.post("/api/templates/:id/rework", async (request) => {
    const { id } = request.params as { id: string };
    const body = ReworkBody.parse(request.body);
    return { job: present(reworkReplica(id, body.note)), review: reviewState(id) };
  });

  /**
   * 出片单位导出的 mp4（③ 验货右路、⑤ 成片播放）。最新一次 build 出完才有；删除过成片的没有。
   * `?download=1` 带 Content-Disposition，以成片名下载（REQ-007、AC-020）
   */
  app.get("/api/productions/:id/video", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!readProduction(id)) throw new EvidenceError("PRODUCTION_NOT_FOUND", "出片单位不存在。", 404);
    const row = readOutputRow(id);
    const build = latestBuildRow(id);
    const noOutput = new EvidenceError("NO_OUTPUT", "这条还没有出好的片子。", 404);
    if (!row || row.output_deleted_at || !build || build.status !== "done" || !build.output_path) throw noOutput;
    const download = (request.query as { download?: string }).download === "1";
    return sendVideoFile(
      request,
      reply,
      build.output_path,
      noOutput,
      download ? { "Content-Disposition": attachment(`${safeFileStem(outputName(row))}.mp4`, "output.mp4") } : {},
    );
  });
}
