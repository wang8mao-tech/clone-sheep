import { open } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notify } from "../agent/agent-service.js";
import { paths } from "../config.js";
import { attachment } from "../lib/content-disposition.js";
import { isInside, realpathOrUndefined } from "../lib/safe-path.js";
import { ArchiveError, requireTemplate } from "../services/archive.js";
import { latestBuildRow } from "../services/build-store.js";
import { outputCosts } from "../services/output-costs.js";
import { deleteOutput, outputBuildIds } from "../services/output-delete.js";
import { settleMeta } from "../services/output-meta.js";
import { requireOutput } from "../services/output-store.js";
import { safeFileStem, zipEntries, zipStream } from "../services/output-zip.js";
import { listOutputs, renameOutput } from "../services/outputs.js";
import { archiveErrorHandler } from "./errors.js";

const RenameBody = z.object({ name: z.string() });

/** ⑤ 改名 / 删除：推给 ⑤；变体还推给 ④（作废、改名要在队列里立刻看到，9.1 第四轮审查 S2-L1） */
function announce(row: { template_id: string; kind: string }, data: object): void {
  notify(`template:${row.template_id}`, "outputs", data);
  if (row.kind === "variant") notify(`template:${row.template_id}`, "variants", data);
}

/** ⑤ 成片库（REQ-007、REQ-009、SCREEN-008） */
export async function outputRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(archiveErrorHandler);

  app.get("/api/templates/:id/outputs", async (request) => {
    const { id } = request.params as { id: string };
    return { outputs: listOutputs(id) };
  });

  app.patch("/api/productions/:id", async (request) => {
    const { id } = request.params as { id: string };
    const row = renameOutput(id, RenameBody.parse(request.body).name);
    announce(row, { productionId: id });
    return { id, name: row.name };
  });

  app.get("/api/productions/:id/costs", async (request) => {
    const { id } = request.params as { id: string };
    return outputCosts(id);
  });

  /**
   * 封面帧（ffmpeg 抽的那一帧）；没有、或文件不在了就 404，界面给占位。
   * 先把文件打开再设响应头：设了 image/jpeg 再打开失败，错误 JSON 就发不出去、变成 500（9.1 审查 S2-2）
   */
  app.get("/api/productions/:id/cover", async (request, reply) => {
    const { id } = request.params as { id: string };
    requireOutput(id);
    const cover = latestBuildRow(id)?.cover_path ?? null;
    const noCover = new ArchiveError("这条成片没有封面", "NO_COVER", 404);
    // 比的是真实路径、打开的也是真实路径：先判后开之间换成链接也跟不出去（9.1 第二轮审查 S2-L2）
    const real = cover ? realpathOrUndefined(cover) : undefined;
    const root = realpathOrUndefined(paths.clients) ?? paths.clients;
    if (!real || !isInside(root, real)) throw noCover;
    const handle = await open(real).catch(() => {
      throw noCover;
    });
    let isFile = false;
    try {
      isFile = (await handle.stat()).isFile();
    } finally {
      if (!isFile) await handle.close();
    }
    if (!isFile) throw noCover;
    void reply.header("Content-Type", "image/jpeg");
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("Cache-Control", "no-store");
    return reply.send(handle.createReadStream());
  });

  /** 多选打包：`?ids=a,b,c`（GET，浏览器直接下载、边打边发；id 都是 UUID，地址不会太长） */
  app.get("/api/templates/:id/outputs/zip", async (request, reply) => {
    const { id } = request.params as { id: string };
    const template = requireTemplate(id);
    const raw = (request.query as { ids?: string }).ids ?? "";
    const entries = zipEntries(
      id,
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    void reply.header("Content-Type", "application/zip");
    void reply.header("Content-Disposition", attachment(`${safeFileStem(template.name)}.zip`, "outputs.zip"));
    return reply.send(zipStream(entries));
  });

  app.delete("/api/productions/:id/output", async (request) => {
    const { id } = request.params as { id: string };
    const row = requireOutput(id);
    // 在跑的封面抽取开着这个文件：等它结束再删（结束时它看到已删会自己收拾封面）
    await settleMeta(outputBuildIds(id));
    const result = deleteOutput(id);
    announce(row, { productionId: id, deleted: true });
    // 只回条数，不回文件路径
    return { removed: result.removed.length, skipped: result.skipped.length };
  });
}
