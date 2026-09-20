import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createClient,
  createTemplate,
  listClients,
  presentClient,
  presentTemplate,
  renameClient,
  requireClient,
  templateStats,
  type TemplateRow,
} from "../services/archive.js";
import { clientImpact, deleteClient } from "../services/deletion.js";
import { db } from "../db/index.js";
import { sseHub } from "../lib/sse.js";
import { archiveErrorHandler } from "./errors.js";

const NameBody = z.object({ name: z.string() });

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(archiveErrorHandler);

  /** 侧栏树 */
  app.get("/api/clients", async () => ({ clients: listClients() }));

  app.post("/api/clients", async (request, reply) => {
    const body = NameBody.parse(request.body);
    const client = createClient(body.name);
    sseHub.publish("global", "archive", { kind: "client", action: "created", id: client.id });
    return reply.status(201).send(presentClient(client));
  });

  /** 客户页：模板紧凑行列表（SCREEN-002） */
  app.get("/api/clients/:id", async (request) => {
    const { id } = request.params as { id: string };
    const client = requireClient(id);
    const rows = db()
      .prepare("SELECT * FROM templates WHERE client_id = ? ORDER BY created_at, rowid")
      .all(id) as TemplateRow[];
    return {
      client: presentClient(client),
      templates: rows.map((row) => ({ ...presentTemplate(row), stats: templateStats(row) })),
    };
  });

  app.patch("/api/clients/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = NameBody.parse(request.body);
    const client = renameClient(id, body.name);
    sseHub.publish("global", "archive", { kind: "client", action: "renamed", id });
    return presentClient(client);
  });

  /** 删除前给弹窗用的级联影响（CMP-012） */
  app.get("/api/clients/:id/deletion-impact", async (request) => {
    const { id } = request.params as { id: string };
    return clientImpact(id);
  });

  app.delete("/api/clients/:id", async (request) => {
    const { id } = request.params as { id: string };
    const impact = deleteClient(id);
    sseHub.publish("global", "archive", { kind: "client", action: "deleted", id });
    return impact;
  });

  app.post("/api/clients/:id/templates", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = NameBody.parse(request.body);
    const template = createTemplate(id, body.name);
    sseHub.publish("global", "archive", { kind: "template", action: "created", id: template.id });
    return reply.status(201).send(presentTemplate(template));
  });
}
