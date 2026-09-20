import { existsSync } from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { ensureWorkspaceLayout } from "../hypit/workspace.js";

export interface WorkspaceMigrationResult {
  /** 本次真的补了东西的模板数 */
  repaired: number;
  /** 本来就齐全，什么都没动 */
  intact: number;
  /** 补不了的，连同原因。目录被删、权限异常都落这里 */
  failures: Array<{ workspacePath: string; reason: string }>;
}

/**
 * 启动时把所有模板的工作目录补齐。
 *
 * Phase 2 建出来的目录既没有 `.hypit/runtime`（hypit 会报 No Runtime Profile
 * is selected），也没有 `references/src`（Phase 4 落盘参考视频时会 ENOENT）。
 * 这里一次补齐，只写小文件、不 spawn 任何进程。
 *
 * 补不了的只记录、不抛：那是脏数据问题，该由删除流程或用户处理，不值得让后端
 * 起不来。但**必须把是哪个模板、为什么补不了说出来**——只报一个 skipped 计数
 * 的话，那个模板会永久处于不可转写状态而没人知道。
 */
export function migrateWorkspaces(): WorkspaceMigrationResult {
  const rows = db().prepare("SELECT workspace_path FROM templates WHERE workspace_path IS NOT NULL").all() as Array<{
    workspace_path: string;
  }>;

  const result: WorkspaceMigrationResult = { repaired: 0, intact: 0, failures: [] };
  for (const row of rows) {
    try {
      // 补没补过东西，靠调用前后的状态判断：ensureWorkspaceLayout 本身是幂等的，
      // 不区分「本来就有」和「刚补上」，而运维要能确认那次修复到底生效没有
      const before = isIntact(row.workspace_path);
      ensureWorkspaceLayout(row.workspace_path);
      if (before) result.intact += 1;
      else result.repaired += 1;
    } catch (error) {
      result.failures.push({
        workspacePath: row.workspace_path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/** 调用前齐不齐。只用来区分「本来就好」与「这次补的」，不替代 ensureWorkspaceLayout 的判据。 */
function isIntact(dir: string): boolean {
  return existsSync(path.join(dir, ".hypit", "runtime")) && existsSync(path.join(dir, "references", "src"));
}
