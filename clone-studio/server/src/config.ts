import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根：server/src → server → clone-studio → 仓库根 */
function findRepoRoot(): string {
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "hypit-main", "bin", "hypit.mjs"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 找不到时退回 clone-studio 的上一级，让体检去报这个问题，而不是在这里崩
  return path.resolve(here, "..", "..", "..", "..");
}

const repoRoot = findRepoRoot();

function envPath(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? path.resolve(raw.trim()) : fallback;
}

export const config = {
  /** 后端只绑回环地址，不对外暴露（Spec 非功能需求） */
  host: "127.0.0.1" as const,
  port: Number(process.env.CLONE_STUDIO_PORT ?? 4310),

  repoRoot,

  /** Hypit 内核的只读副本。绝不写入。 */
  hypitRoot: envPath("CLONE_STUDIO_HYPIT_ROOT", path.join(repoRoot, "hypit-main")),

  /**
   * 数据根目录：数据库、工程目录、成片、上传件都在这里。
   * 默认放用户目录而非仓库内，避免误入 git。
   */
  dataRoot: envPath("CLONE_STUDIO_DATA_ROOT", path.join(homedir(), ".clone-studio")),
} as const;

export const paths = {
  db: path.join(config.dataRoot, "app.db"),
  /** 密钥单独一份文件，权限收紧，永不入库 */
  secrets: path.join(config.dataRoot, "secrets.json"),
  /** 媒体与 Hypit 工程文件：<data>/clients/<id>/templates/<id>/（Spec 6.3） */
  clients: path.join(config.dataRoot, "clients"),
  uploads: path.join(config.dataRoot, "uploads"),
  outputs: path.join(config.dataRoot, "outputs"),
  hypitCli: path.join(config.hypitRoot, "bin", "hypit.mjs"),
  hypitSkill: path.join(config.hypitRoot, "skills", "hypit"),
} as const;
