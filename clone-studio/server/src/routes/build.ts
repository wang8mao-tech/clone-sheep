import type { FastifyError, FastifyInstance } from "fastify";
import { BuildError, cancelBuild, latestBuild, retryBuild, startBuild } from "../services/build-run.js";
import { archiveErrorHandler } from "./errors.js";

/** 出片（REQ-006）：看进度 / 结果，取消，重试。起片由执行器按闸门自动做，这里只给人工入口 */
export async function buildRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof BuildError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    return archiveErrorHandler(error, request, reply);
  });

  app.get("/api/productions/:id/build", async (request, reply) => {
    const { id } = request.params as { id: string };
    const build = latestBuild(id);
    if (!build) return reply.status(404).send({ error: { code: "NO_BUILD", message: "这条还没有出过片" } });
    return { build };
  });

  /** 手动起片：闸门放行了但执行器没起来（并发满、重启）时用；不满足放行条件会被拒 */
  app.post("/api/productions/:id/build", async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.code(201).send({ build: await startBuild(id) });
  });

  app.post("/api/productions/:id/build/cancel", async (request) => {
    const { id } = request.params as { id: string };
    return { build: await cancelBuild(id) };
  });

  app.post("/api/productions/:id/build/retry", async (request) => {
    const { id } = request.params as { id: string };
    return retryBuild(id);
  });
}
