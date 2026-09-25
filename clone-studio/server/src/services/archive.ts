import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { codexEndpoint } from "../hypit/codex.js";
import { codexPackageProblem } from "../hypit/codex-package.js";
import { type WorkspaceServices } from "../hypit/runtime-profile.js";
import { createWorkspace } from "../hypit/workspace.js";

/**
 * 归档服务：客户与模板的创建、改名、查询（REQ-001）。
 * 删除在 deletion.ts，因为它要动磁盘且要先停任务。
 */

export type TemplateStatus = "importing" | "cloning" | "awaiting_review" | "approved" | "failed";

const CLIENT_NAME_MAX = 40;
const TEMPLATE_NAME_MAX = 60;

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

/** 去首尾空格后按码点计长度。中文一个字算一个，与 Spec 的「1-40 字」一致。 */
export function normalizeName(raw: string, max: number, what: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new ArchiveError(`${what}不能为空`, "NAME_EMPTY", 400);
  if ([...name].length > max) throw new ArchiveError(`${what}最长 ${max} 字`, "NAME_TOO_LONG", 400);
  return name;
}

export interface ClientSummary {
  id: string;
  name: string;
  createdAt: string;
  templates: Array<{ id: string; name: string; status: TemplateStatus }>;
}

interface TreeRow {
  id: string;
  name: string;
  created_at: string;
  t_id: string | null;
  t_name: string | null;
  t_status: TemplateStatus | null;
}

/** 侧栏树：客户 → 模板，各自按创建时间排。 */
export function listClients(): ClientSummary[] {
  const rows = db()
    .prepare(
      `SELECT c.id, c.name, c.created_at,
              t.id AS t_id, t.name AS t_name, t.status AS t_status
         FROM clients c
         LEFT JOIN templates t ON t.client_id = c.id
        ORDER BY c.created_at, c.rowid, t.created_at, t.rowid`,
    )
    .all() as TreeRow[];

  const byId = new Map<string, ClientSummary>();
  for (const row of rows) {
    let client = byId.get(row.id);
    if (!client) {
      client = { id: row.id, name: row.name, createdAt: row.created_at, templates: [] };
      byId.set(row.id, client);
    }
    if (row.t_id && row.t_name && row.t_status) {
      client.templates.push({ id: row.t_id, name: row.t_name, status: row.t_status });
    }
  }
  return [...byId.values()];
}

export interface ClientRow {
  id: string;
  name: string;
  created_at: string;
}

export function findClient(id: string): ClientRow | undefined {
  return db().prepare("SELECT * FROM clients WHERE id = ?").get(id) as ClientRow | undefined;
}

export function requireClient(id: string): ClientRow {
  const row = findClient(id);
  if (!row) throw new ArchiveError("客户不存在", "CLIENT_NOT_FOUND", 404);
  return row;
}

export function createClient(rawName: string): ClientRow {
  const name = normalizeName(rawName, CLIENT_NAME_MAX, "客户名");
  assertClientNameFree(name);
  const row: ClientRow = { id: randomUUID(), name, created_at: new Date().toISOString() };
  db().prepare("INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)").run(row.id, row.name, row.created_at);
  return row;
}

export function renameClient(id: string, rawName: string): ClientRow {
  const current = requireClient(id);
  const name = normalizeName(rawName, CLIENT_NAME_MAX, "客户名");
  if (name !== current.name) assertClientNameFree(name);
  db().prepare("UPDATE clients SET name = ? WHERE id = ?").run(name, id);
  return { ...current, name };
}

function assertClientNameFree(name: string): void {
  const taken = db().prepare("SELECT 1 FROM clients WHERE name = ?").get(name);
  if (taken) throw new ArchiveError("名称已存在", "NAME_TAKEN", 409);
}

export interface TemplateRow {
  id: string;
  client_id: string;
  name: string;
  language: string | null;
  default_video_channel: string | null;
  source_kind: "file" | "url" | null;
  source_url: string | null;
  source_path: string | null;
  workspace_path: string | null;
  note: string | null;
  status: TemplateStatus;
  /** 通过验货的那一版复刻片；没通过是 null */
  approved_replica_id: string | null;
  /** ①参考 选的 Agent 模型档案（REQ-010） */
  agent_profile_id: string | null;
  created_at: string;
  updated_at: string;
}

export function findTemplate(id: string): TemplateRow | undefined {
  return db().prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined;
}

export function requireTemplate(id: string): TemplateRow {
  const row = findTemplate(id);
  if (!row) throw new ArchiveError("模板不存在", "TEMPLATE_NOT_FOUND", 404);
  return row;
}

/**
 * 建模板即建它的 Hypit 工程目录：AC-001 要验「磁盘上的目录不存在」，
 * 目录必须在删除之前就真的存在。参考视频的导入是 Phase 4 的事。
 */
export function createTemplate(clientId: string, rawName: string): TemplateRow {
  const client = requireClient(clientId);
  const name = normalizeName(rawName, TEMPLATE_NAME_MAX, "模板名");
  assertTemplateNameFree(clientId, name);

  const id = randomUUID();
  const now = new Date().toISOString();
  const workspace = createWorkspace({
    clientId: client.id,
    templateId: id,
    slug: name,
    services: workspaceServices(),
  });

  db()
    .prepare(
      `INSERT INTO templates (id, client_id, name, workspace_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'importing', ?, ?)`,
    )
    .run(id, client.id, name, workspace.dir, now, now);
  return requireTemplate(id);
}

export function renameTemplate(id: string, rawName: string): TemplateRow {
  const current = requireTemplate(id);
  const name = normalizeName(rawName, TEMPLATE_NAME_MAX, "模板名");
  if (name !== current.name) assertTemplateNameFree(current.client_id, name);
  const now = new Date().toISOString();
  db().prepare("UPDATE templates SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id);
  return { ...current, name, updated_at: now };
}

function assertTemplateNameFree(clientId: string, name: string): void {
  const taken = db().prepare("SELECT 1 FROM templates WHERE client_id = ? AND name = ?").get(clientId, name);
  if (taken) throw new ArchiveError("名称已存在", "NAME_TAKEN", 409);
}

/** 工程目录里写哪些 endpoint，取决于设置里的凭据验过没有、并发开多大。 */
export function workspaceServices(): WorkspaceServices {
  const row = db()
    .prepare(
      `SELECT render_workers, render_concurrency, tokendance_verified_at, hypihub_verified_at, codex_provider_enabled
         FROM settings WHERE id = 1`,
    )
    .get() as
    | {
        render_workers: number;
        render_concurrency: number;
        tokendance_verified_at: string | null;
        hypihub_verified_at: string | null;
        codex_provider_enabled: number;
      }
    | undefined;

  return {
    tokendance: Boolean(row?.tokendance_verified_at),
    hypihub: Boolean(row?.hypihub_verified_at),
    // WhisperX 一律绑上：服务没起时 hypit 报 MANAGED_PROGRAM_DOWN，
    // 比「无 Provider 可解析」更能指出真正的问题（连通性检测留到 Phase 4）
    whisperx: true,
    renderWorkers: row?.render_workers ?? 1,
    renderConcurrency: row?.render_concurrency ?? 1,
    // 启用了、而且数据根里真有 Provider 包才绑（开关由设置接口按体检把关，REQ-011）。包不在还绑的话，每个模板的
    // plan 与 programs up 都会因解析不到包而失败——连不用 gpt-image 的片子也出不了（11.2 审查 M1）；
    // codex 不见了也不绑，gpt-image 会明确报缺能力
    codex: row?.codex_provider_enabled === 1 && codexPackageProblem() === null ? codexEndpoint() : null,
  };
}

/** 对外形状：库里是 snake_case，接口一律 camelCase。 */
export function presentClient(row: ClientRow) {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export function presentTemplate(row: TemplateRow) {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    status: row.status,
    language: row.language,
    note: row.note,
    sourceKind: row.source_kind,
    sourceUrl: row.source_url,
    /** 参考视频导入了没有。缩略帧要等 Phase 4 抽帧才有。 */
    hasSource: Boolean(row.source_path),
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface TemplateStats {
  outputs: number;
  /** 合计花费。Agent 花费与 build 估价都是估算值，前端要带「估」徽标。 */
  totalCostUsd: number;
  costIsEstimate: boolean;
  /** 有 Agent 任务的档案没填单价、花费算不出（不在合计里）：界面标「含未知」（Phase 10 交接，Task 11.4） */
  costHasUnknown: boolean;
  lastActivityAt: string;
}

export function templateStats(template: TemplateRow): TemplateStats {
  const d = db();
  // 成片数：变体出完就算；复刻片只算「通过验货」的那一版（REQ-004：它是第一条成片），打回前的旧版本不算
  const outputs = (
    d
      .prepare(
        `SELECT COUNT(*) AS n FROM productions
          WHERE template_id = ? AND status = 'done' AND output_deleted_at IS NULL
            AND (kind = 'variant' OR (? = 'approved' AND id = ?))`,
      )
      .get(template.id, template.status, template.approved_replica_id) as { n: number }
  ).n;

  const agent = d
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS sum,
              SUM(CASE WHEN cost_usd > 0 AND cost_is_estimate = 1 THEN 1 ELSE 0 END) AS est,
              SUM(CASE WHEN cost_basis = 'none' THEN 1 ELSE 0 END) AS unknown
         FROM agent_jobs
        WHERE (owner_kind = 'template' AND owner_id = ?)
           OR (owner_kind = 'production' AND owner_id IN (SELECT id FROM productions WHERE template_id = ?))`,
    )
    .get(template.id, template.id) as { sum: number; est: number | null; unknown: number | null };

  const build = d
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(actual_usd, estimate_usd)), 0) AS sum,
              SUM(CASE WHEN actual_usd IS NULL AND estimate_usd IS NOT NULL THEN 1 ELSE 0 END) AS est
         FROM builds
        WHERE production_id IN (SELECT id FROM productions WHERE template_id = ?)`,
    )
    .get(template.id) as { sum: number; est: number | null };

  const lastProduction = (
    d.prepare("SELECT MAX(updated_at) AS at FROM productions WHERE template_id = ?").get(template.id) as {
      at: string | null;
    }
  ).at;

  return {
    outputs,
    totalCostUsd: agent.sum + build.sum,
    costIsEstimate: (agent.est ?? 0) > 0 || (build.est ?? 0) > 0,
    costHasUnknown: (agent.unknown ?? 0) > 0,
    lastActivityAt: lastProduction && lastProduction > template.updated_at ? lastProduction : template.updated_at,
  };
}
