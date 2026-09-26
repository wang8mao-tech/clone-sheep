import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, paths } from "../config.js";

let handle: Database.Database | undefined;

/**
 * 打开（并在首次打开时创建）数据库。
 * better-sqlite3 是同步 API，状态机的读改写不用处理并发交织。
 */
export function db(): Database.Database {
  if (handle) return handle;

  mkdirSync(config.dataRoot, { recursive: true });
  mkdirSync(paths.clients, { recursive: true });
  mkdirSync(paths.uploads, { recursive: true });
  mkdirSync(paths.outputs, { recursive: true });

  const next = new Database(paths.db);
  // WAL 让读不挡写；外键约束必须每个连接单独打开，不随文件持久化。
  next.pragma("journal_mode = WAL");
  next.pragma("foreign_keys = ON");
  handle = next;
  return handle;
}

export function closeDb(): void {
  handle?.close();
  handle = undefined;
}

/** schema.sql 与本模块同目录：开发期在 src/db，构建后由 build 脚本复制到 dist/db。 */
export function schemaPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");
}
