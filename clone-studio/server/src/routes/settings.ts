import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config, paths } from "../config.js";
import { db } from "../db/index.js";
import { healthSummary, verifyTokenDance } from "../health/checks.js";
import { getSecret, maskSecret, setSecret } from "../lib/secrets.js";
import { sseHub } from "../lib/sse.js";

const SettingsPatch = z.object({
  perItemLimitUsd: z.number().min(0).max(100).optional(),
  batchLimitUsd: z.number().min(0).max(1000).optional(),
  agentTimeoutMinutes: z.number().int().min(1).max(600).optional(),
  agentBudgetUsd: z.number().min(0).max(1000).optional(),
  agentConcurrency: z.number().int().min(1).max(16).optional(),
  renderConcurrency: z.number().int().min(1).max(8).optional(),
  renderWorkers: z.number().int().min(1).max(32).optional(),
  referenceMaxSeconds: z.number().int().min(10).max(3600).optional(),
  batchMaxItems: z.number().int().min(1).max(200).optional(),
  codexProviderEnabled: z.boolean().optional(),
});

const COLUMN: Record<keyof z.infer<typeof SettingsPatch>, string> = {
  perItemLimitUsd: "per_item_limit_usd",
  batchLimitUsd: "batch_limit_usd",
  agentTimeoutMinutes: "agent_timeout_minutes",
  agentBudgetUsd: "agent_budget_usd",
  agentConcurrency: "agent_concurrency",
  renderConcurrency: "render_concurrency",
  renderWorkers: "render_workers",
  referenceMaxSeconds: "reference_max_seconds",
  batchMaxItems: "batch_max_items",
  codexProviderEnabled: "codex_provider_enabled",
};

interface SettingsRow {
  per_item_limit_usd: number;
  batch_limit_usd: number;
  agent_timeout_minutes: number;
  agent_budget_usd: number;
  agent_concurrency: number;
  render_concurrency: number;
  render_workers: number;
  reference_max_seconds: number;
  batch_max_items: number;
  codex_provider_enabled: number;
  tokendance_verified_at: string | null;
  hypihub_verified_at: string | null;
  updated_at: string;
}

function readSettings(): SettingsRow {
  return db().prepare("SELECT * FROM settings WHERE id = 1").get() as SettingsRow;
}

function present(row: SettingsRow) {
  return {
    perItemLimitUsd: row.per_item_limit_usd,
    batchLimitUsd: row.batch_limit_usd,
    agentTimeoutMinutes: row.agent_timeout_minutes,
    agentBudgetUsd: row.agent_budget_usd,
    agentConcurrency: row.agent_concurrency,
    renderConcurrency: row.render_concurrency,
    renderWorkers: row.render_workers,
    referenceMaxSeconds: row.reference_max_seconds,
    batchMaxItems: row.batch_max_items,
    codexProviderEnabled: row.codex_provider_enabled === 1,
    updatedAt: row.updated_at,
    paths: {
      dataRoot: config.dataRoot,
      hypitRoot: config.hypitRoot,
      secrets: paths.secrets,
    },
    // 凭据只回打码值，明文永不出后端（Spec REQ-008）
    credentials: {
      tokendance: maskSecret("tokendance.apiKey"),
      hypihub: maskSecret("hypihub.token"),
      tokendanceVerifiedAt: row.tokendance_verified_at,
      hypihubVerifiedAt: row.hypihub_verified_at,
    },
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => present(readSettings()));

  app.patch("/api/settings", async (request, reply) => {
    const parsed = SettingsPatch.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_BODY", message: "设置项不合法", detail: parsed.error.issues },
      });
    }
    const entries = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
    if (entries.length > 0) {
      const assignments = entries.map(([k]) => `${COLUMN[k as keyof typeof COLUMN]} = ?`).join(", ");
      const values = entries.map(([, v]) => (typeof v === "boolean" ? (v ? 1 : 0) : v));
      db()
        .prepare(`UPDATE settings SET ${assignments}, updated_at = ? WHERE id = 1`)
        .run(...values, new Date().toISOString());
    }
    // 批次限额不得低于单条限额（Spec REQ-006 的输入约束）
    const row = readSettings();
    if (row.batch_limit_usd < row.per_item_limit_usd) {
      return reply.status(400).send({
        error: { code: "LIMIT_ORDER", message: "批次限额不能低于单条限额" },
      });
    }
    sseHub.publish("global", "settings", { updatedAt: row.updated_at });
    return present(row);
  });

  app.get("/api/health/checks", async () => healthSummary());

  const SecretBody = z.object({
    key: z.enum(["tokendance.apiKey", "hypihub.token"]),
    value: z.string().nullable(),
  });

  app.put("/api/settings/secret", async (request, reply) => {
    const parsed = SecretBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "INVALID_BODY", message: "凭据参数不合法" } });
    }
    setSecret(parsed.data.key, parsed.data.value);
    // key 一改，之前的验证结果立刻作废
    const column = parsed.data.key === "tokendance.apiKey" ? "tokendance_verified_at" : "hypihub_verified_at";
    db().prepare(`UPDATE settings SET ${column} = NULL, updated_at = ? WHERE id = 1`).run(new Date().toISOString());
    sseHub.publish("global", "settings", { credential: parsed.data.key });
    return { masked: maskSecret(parsed.data.key) };
  });

  /**
   * 验证 TokenDance key（AC-023）。
   * 见 checks.ts 的说明：hypit 没有校验远端凭据的命令，所以这里直接打
   * TokenDance 的只读目录接口，无效 key 会拿到 4xx 与原文。
   */
  app.post("/api/settings/verify/tokendance", async () => {
    const result = await verifyTokenDance(getSecret("tokendance.apiKey"));
    db()
      .prepare("UPDATE settings SET tokendance_verified_at = ?, updated_at = ? WHERE id = 1")
      .run(result.ok ? new Date().toISOString() : null, new Date().toISOString());
    sseHub.publish("global", "settings", { verified: "tokendance", ok: result.ok });
    return result;
  });
}
