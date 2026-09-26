// tsc 不复制非 TS 文件：把 schema.sql 搬到 dist，保证构建产物能自举建库。
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(path.join(root, "dist", "db"), { recursive: true });
copyFileSync(path.join(root, "src", "db", "schema.sql"), path.join(root, "dist", "db", "schema.sql"));
console.log("copy-assets: schema.sql -> dist/db/schema.sql");
