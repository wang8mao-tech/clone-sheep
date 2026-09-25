import { open } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isInside, realpathOrUndefined } from "../lib/safe-path.js";
import { codexTryImage, codexTryRoot, codexTryState, CodexTryError, startCodexTry } from "../services/codex-try.js";

/**
 * 设置页「试出一张图」（REQ-011）：起一次、查最近一次、取那张图。
 * 出一张图要几分钟：POST 立刻回 202，结果看 GET 与 SSE 的 `codex-try` 事件。
 */
export async function codexRoutes(app: FastifyInstance): Promise<void> {
  const sendError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof CodexTryError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    throw error;
  };

  app.get("/api/codex/try", async () => ({ try: codexTryState() }));

  app.post("/api/codex/try", async (_request, reply) => {
    try {
      return reply.status(202).send({ try: await startCodexTry() });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** 先打开文件再设响应头（同封面帧，9.1 审查 S2-2）；只认 codex-try 目录里的真实路径 */
  app.get("/api/codex/try/:id/image", async (request, reply) => {
    const { id } = request.params as { id: string };
    const missing = () => reply.status(404).send({ error: { code: "NO_IMAGE", message: "这一次没有出图" } });
    const file = codexTryImage(id);
    const real = file ? realpathOrUndefined(file) : undefined;
    const root = realpathOrUndefined(codexTryRoot()) ?? codexTryRoot();
    if (!real || !isInside(root, real)) return missing();
    const handle = await open(real).catch(() => undefined);
    if (!handle) return missing();
    if (!(await handle.stat()).isFile()) {
      await handle.close();
      return missing();
    }
    void reply.header("Content-Type", "image/png");
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("Cache-Control", "no-store");
    return reply.send(handle.createReadStream());
  });
}
