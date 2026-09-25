import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { getSecret, maskSecret, setSecret, type SecretKey } from "../lib/secrets.js";
import { SUBSCRIPTION_PROFILE_ID, type ProfileKind } from "./profile-presets.js";
import {
  cleanBaseUrl,
  cleanModel,
  cleanName,
  cleanOptional,
  cleanPrice,
  cleanToken,
  ProfileError,
} from "./profile-validate.js";

export { ProfileError };

/**
 * 模型档案（Spec REQ-010）：档案本身存库，token 只存 secrets.json（REQ-008 同款），接口只回打码值。
 * 测试连接在 profile-test.ts；运行器按档案给会话注入环境在 Task 10.2。
 */

export interface ProfileRow {
  id: string;
  name: string;
  kind: ProfileKind;
  base_url: string | null;
  model_id: string | null;
  fast_model_id: string | null;
  supports_vision: number;
  supports_web_search: number;
  price_in: number | null;
  price_out: number | null;
  verified_at: string | null;
  is_default: number;
  builtin: number;
  created_at: string;
  updated_at: string | null;
}

export interface ProfileView {
  id: string;
  name: string;
  kind: ProfileKind;
  baseUrl: string | null;
  modelId: string | null;
  fastModelId: string | null;
  supportsVision: boolean;
  supportsWebSearch: boolean;
  priceIn: number | null;
  priceOut: number | null;
  verifiedAt: string | null;
  isDefault: boolean;
  builtin: boolean;
  /** token 打码值；没有 token（订阅档案）是 null */
  token: string | null;
  /** 兼容端点没填全单价：$ 熔断不生效（REQ-010），界面在档案上标出来 */
  budgetNote: string | null;
}

/** 还没结束的任务：它们开跑 / 续跑时要用档案，档案不能删 */
const ACTIVE_JOB = ["queued", "running", "awaiting_quota"];

export const tokenKey = (id: string): SecretKey => `modelProfile.${id}.token`;

export const NO_PRICE_NOTE = "没填单价：$ 熔断不生效，只靠时长与卡死检测";

/** 兼容端点花费按单价折算；两项都填了才算得出来（REQ-010） */
export function priced(row: Pick<ProfileRow, "price_in" | "price_out">): boolean {
  return row.price_in !== null && row.price_out !== null;
}

export function presentProfile(row: ProfileRow): ProfileView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    modelId: row.model_id,
    fastModelId: row.fast_model_id,
    supportsVision: row.supports_vision === 1,
    supportsWebSearch: row.supports_web_search === 1,
    priceIn: row.price_in,
    priceOut: row.price_out,
    verifiedAt: row.verified_at,
    isDefault: row.is_default === 1,
    builtin: row.builtin === 1,
    token: row.kind === "subscription" ? null : maskSecret(tokenKey(row.id)),
    budgetNote: row.kind === "compatible" && !priced(row) ? NO_PRICE_NOTE : null,
  };
}

export function listProfiles(): ProfileRow[] {
  return db().prepare("SELECT * FROM model_profiles ORDER BY builtin DESC, created_at, name").all() as ProfileRow[];
}

export function findProfile(id: string): ProfileRow | undefined {
  return db().prepare("SELECT * FROM model_profiles WHERE id = ?").get(id) as ProfileRow | undefined;
}

export function requireProfile(id: string): ProfileRow {
  const row = findProfile(id);
  if (!row) throw new ProfileError("PROFILE_NOT_FOUND", "模型档案不存在。", 404);
  return row;
}

/** 默认档案；万一没有标默认的（库被手改过），退回内置订阅 */
export function defaultProfile(): ProfileRow {
  const row = db().prepare("SELECT * FROM model_profiles WHERE is_default = 1 LIMIT 1").get() as ProfileRow | undefined;
  return row ?? requireProfile(SUBSCRIPTION_PROFILE_ID);
}

/** 明文 token：只给运行器与测试连接用，绝不进响应体 */
export function profileToken(id: string): string | undefined {
  return getSecret(tokenKey(id));
}

export interface ProfileInput {
  name: string;
  /** subscription = 「本机订阅 · 指定模型」：走本机登录态、不收 base_url 与 token，只指定模型 */
  kind: ProfileKind;
  baseUrl?: string | null | undefined;
  token?: string | undefined;
  modelId: string;
  fastModelId?: string | null | undefined;
  supportsVision: boolean;
  supportsWebSearch: boolean;
  priceIn?: number | null | undefined;
  priceOut?: number | null | undefined;
}

export type ProfilePatch = Partial<Omit<ProfileInput, "kind">>;

export function createProfile(input: ProfileInput): ProfileRow {
  const name = cleanName(input.name);
  const baseUrl = cleanBaseUrl(input.kind, input.baseUrl);
  const model = cleanModel(input.modelId);
  // 订阅档案没有 key；给了也不存
  const token = input.kind === "subscription" ? undefined : cleanToken(input.token ?? "");
  const id = randomUUID();
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO model_profiles (id, name, kind, base_url, model_id, fast_model_id, supports_vision, supports_web_search,
         price_in, price_out, verified_at, is_default, builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, ?, ?)`,
    )
    .run(
      id,
      name,
      input.kind,
      baseUrl,
      model,
      cleanOptional(input.fastModelId),
      input.supportsVision ? 1 : 0,
      input.supportsWebSearch ? 1 : 0,
      cleanPrice(input.priceIn),
      cleanPrice(input.priceOut),
      now,
      now,
    );
  if (token !== undefined) setSecret(tokenKey(id), token);
  return requireProfile(id);
}

export function updateProfile(id: string, patch: ProfilePatch): ProfileRow {
  const row = requireProfile(id);
  if (row.builtin === 1) throw new ProfileError("BUILTIN_READONLY", "内置的订阅档案不能改，只能设为默认。", 409);
  const kind = row.kind;
  const next = {
    name: patch.name !== undefined ? cleanName(patch.name, id) : row.name,
    base_url: patch.baseUrl !== undefined ? cleanBaseUrl(kind, patch.baseUrl) : row.base_url,
    model_id: patch.modelId !== undefined ? cleanModel(patch.modelId) : row.model_id,
    fast_model_id: patch.fastModelId !== undefined ? cleanOptional(patch.fastModelId) : row.fast_model_id,
    supports_vision: patch.supportsVision !== undefined ? (patch.supportsVision ? 1 : 0) : row.supports_vision,
    supports_web_search:
      patch.supportsWebSearch !== undefined ? (patch.supportsWebSearch ? 1 : 0) : row.supports_web_search,
    price_in: patch.priceIn !== undefined ? cleanPrice(patch.priceIn) : row.price_in,
    price_out: patch.priceOut !== undefined ? cleanPrice(patch.priceOut) : row.price_out,
  };
  // token 不填就沿用原来的（界面只拿得到打码值）
  const token = kind !== "subscription" && patch.token?.trim() ? cleanToken(patch.token) : undefined;
  // 连接相关的变了：之前的「已验证」不再作数，要重新测试
  const reconnect =
    token !== undefined ||
    next.base_url !== row.base_url ||
    next.model_id !== row.model_id ||
    next.fast_model_id !== row.fast_model_id ||
    // 打开看图：之前测的时候没带图，不能算看图也验过了（10.1 审查 L1）
    (next.supports_vision === 1 && row.supports_vision === 0);
  db()
    .prepare(
      `UPDATE model_profiles SET name = ?, base_url = ?, model_id = ?, fast_model_id = ?, supports_vision = ?,
         supports_web_search = ?, price_in = ?, price_out = ?, verified_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      next.name,
      next.base_url,
      next.model_id,
      next.fast_model_id,
      next.supports_vision,
      next.supports_web_search,
      next.price_in,
      next.price_out,
      reconnect ? null : row.verified_at,
      new Date().toISOString(),
      id,
    );
  if (token !== undefined) setSecret(tokenKey(id), token);
  return requireProfile(id);
}

/** 删档案：内置的不行，还有没结束的任务在用也不行；历史任务的档案名与模型 id 是快照，不受影响（AC-030） */
export function deleteProfile(id: string): void {
  const row = requireProfile(id);
  if (row.builtin === 1) throw new ProfileError("BUILTIN_UNDELETABLE", "内置的订阅档案不能删。", 409);
  const active = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_jobs WHERE profile_id = ? AND status IN (${ACTIVE_JOB.map(() => "?").join(", ")})`,
    )
    .get(id, ...ACTIVE_JOB) as { n: number };
  if (active.n > 0) {
    throw new ProfileError(
      "PROFILE_IN_USE",
      `还有 ${active.n} 个没结束的任务在用这个档案，等它们结束或取消后再删。`,
      409,
    );
  }
  db().transaction(() => {
    db().prepare("DELETE FROM model_profiles WHERE id = ?").run(id);
    if (row.is_default === 1) {
      db().prepare("UPDATE model_profiles SET is_default = 1 WHERE id = ?").run(SUBSCRIPTION_PROFILE_ID);
    }
  })();
  setSecret(tokenKey(id), null);
}

export function setDefaultProfile(id: string): ProfileRow {
  requireProfile(id);
  db().transaction(() => {
    db().prepare("UPDATE model_profiles SET is_default = 0 WHERE is_default = 1").run();
    db().prepare("UPDATE model_profiles SET is_default = 1 WHERE id = ?").run(id);
  })();
  return requireProfile(id);
}

/** 测试连接的结论：成功记时间，失败清掉（REQ-010「档案保存但标未验证」） */
export function markVerified(id: string, at: string | null): ProfileRow {
  db().prepare("UPDATE model_profiles SET verified_at = ? WHERE id = ?").run(at, id);
  return requireProfile(id);
}
