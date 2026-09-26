import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { config, paths } from "../config.js";
import { db } from "../db/index.js";
import { sseHub } from "../lib/sse.js";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => {
    const tables = db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    return {
      ok: true,
      version: "0.1.0",
      host: config.host,
      port: config.port,
      dataRoot: config.dataRoot,
      hypitRoot: config.hypitRoot,
      hypitCliPresent: existsSync(paths.hypitCli),
      tables,
    };
  });

  /**
   * 事件流。topics 以逗号分隔，缺省只订阅 global。
   * 断线重连由浏览器自动带 Last-Event-ID；补发范围见 SseHub 的说明。
   */
  app.get("/api/events", (request, reply) => {
    const query = request.query as { topics?: string };
    const topics = (query.topics ?? "global")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const header = request.headers["last-event-id"];
    const lastEventId = typeof header === "string" && /^\d+$/.test(header) ? Number(header) : undefined;
    sseHub.subscribe(reply, topics, lastEventId);
    // 不 return，连接保持打开
  });
}
