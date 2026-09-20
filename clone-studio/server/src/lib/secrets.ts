import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config, paths } from "../config.js";

/**
 * 密钥文件。
 *
 * 规则（Spec REQ-008）：
 * - 只存在本机应用数据目录，文件权限限当前用户
 * - 绝不入库、绝不写进模板工程目录
 * - 接口只回打码值，明文只在 spawn 子进程时作为环境变量注入
 */
export type SecretKey =
  | "tokendance.apiKey"
  | "hypihub.token"
  | "minimax.apiKey"
  | "jimeng.token"
  | `modelProfile.${string}.token`;

type Store = Partial<Record<string, string>>;

function read(): Store {
  if (!existsSync(paths.secrets)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.secrets, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    // 文件坏了不能让整个后端起不来；当作空，界面会显示"未配置"
    return {};
  }
}

function write(store: Store): void {
  mkdirSync(config.dataRoot, { recursive: true });
  writeFileSync(paths.secrets, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    // Windows 上 mode 基本没用，但 POSIX 上必须收紧；失败不影响功能
    chmodSync(paths.secrets, 0o600);
  } catch {
    /* 忽略 */
  }
}

/** 明文。只允许喂给子进程环境变量，绝不进任何响应体。 */
export function getSecret(key: SecretKey): string | undefined {
  const value = read()[key];
  return value && value.length > 0 ? value : undefined;
}

export function setSecret(key: SecretKey, value: string | null): void {
  const store = read();
  if (value === null || value.trim() === "") delete store[key];
  else store[key] = value.trim();
  write(store);
}

export function hasSecret(key: SecretKey): boolean {
  return getSecret(key) !== undefined;
}

/**
 * 打码：保留前 3 位与后 4 位，中间固定 12 个点。
 * 长度不足 10 位时整串打掉——短 key 露两头等于没打。
 */
export function maskSecret(key: SecretKey): string | null {
  const value = getSecret(key);
  if (value === undefined) return null;
  if (value.length < 10) return "•".repeat(12);
  return `${value.slice(0, 3)}${"•".repeat(12)}${value.slice(-4)}`;
}

/** 给 hypit 子进程注入凭据。对应 runtime profile 里的 @hypit/credential-store-env。 */
export function credentialEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const tokendance = getSecret("tokendance.apiKey");
  if (tokendance) env.TOKENDANCE_API_KEY = tokendance;
  const hypihub = getSecret("hypihub.token");
  if (hypihub) env.HYPIHUB_TOKEN = hypihub;
  const minimax = getSecret("minimax.apiKey");
  if (minimax) env.MINIMAX_API_KEY = minimax;
  return env;
}
