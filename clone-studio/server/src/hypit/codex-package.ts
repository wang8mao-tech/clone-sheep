import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { config, paths } from "../config.js";

/**
 * 把 Codex Provider 包同步到 `<数据根>/node_modules/@clone-studio/codex-image`（REQ-011）。
 *
 * 为什么不用 `--package-root`：hypit 只有 check / plan / pricing / build 认它，doctor、programs、runtime
 * 都不认，profile 里一出现这个包它们就报「cannot resolve installed package」（whisperx 的 `programs up`、
 * 收尾的 `runtime down` 全坏），而且在跑的 Worker 不看新的 package-root。hypit 找包会从工作目录往上
 * 逐级查 `node_modules/<包名>`，模板工作目录都在数据根下，放这里所有命令不带参数都能找到（Phase 11 spike）。
 *
 * 只拷 package.json 与 src 里的非测试 `.ts`（activation 直接是 .ts，发行版在 CLI 与 Worker 里都注册了 tsx）。
 * 内容没变不写；目标里多出来的文件删掉；路径上任何一级是链接（junction / symlink）就拒绝——
 * 顺着链接写会写到数据根之外。
 */

export const CODEX_PACKAGE_DIR = ["node_modules", "@clone-studio", "codex-image"] as const;

export function installedCodexPackageDir(): string {
  return path.join(config.dataRoot, ...CODEX_PACKAGE_DIR);
}

/** 源码里要带过去的文件（相对包根） */
export function codexPackageFiles(source: string = paths.codexProviderSource): string[] {
  const src = path.join(source, "src");
  if (!existsSync(path.join(source, "package.json")) || !existsSync(src)) {
    throw new Error(`找不到 Codex Provider 源码：${source}`);
  }
  const files = ["package.json"];
  for (const entry of readdirSync(src, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    // 只拷第一层：有子目录时报错，而不是悄悄漏掉、等运行时 import 失败（11.2 审查 L3）
    if (entry.isDirectory()) throw new Error(`Codex Provider 的 src 里不支持子目录：${entry.name}`);
    const name = entry.name;
    if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) files.push(`src/${name}`);
  }
  return files;
}

function assertNoLink(target: string): void {
  let current = config.dataRoot;
  for (const part of path.relative(config.dataRoot, target).split(path.sep)) {
    current = path.join(current, part);
    // lstat 而不是 existsSync：悬空的链接 existsSync 是 false，会被放过去（11.2 审查 L2）
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      /* 不存在 */
    }
    if (isLink) throw new Error(`拒绝同步 Codex Provider：${current} 是链接`);
  }
}

function listFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) return [rel];
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
  });
}

/** 最近一次同步失败的原因；成功就清掉（体检行据此报「包没同步上」，11.2 审查 M1） */
let lastSyncError: string | null = null;

export function codexPackageProblem(): string | null {
  const dir = installedCodexPackageDir();
  if (lastSyncError) return `Provider 包没同步上：${lastSyncError}`;
  if (!existsSync(path.join(dir, "package.json")) || !existsSync(path.join(dir, "src", "activation.ts"))) {
    return "Provider 包不在数据根里（还没同步过）";
  }
  return null;
}

/**
 * 删多出来的一项：链接只删链接本身、绝不跟进去。Windows 上对目录 junction 调 rmSync 会 EISDIR、删不掉
 * （审查实测），于是同步一直失败——链接先 unlink，不行再 rmdir（对 junction 只摘掉链接，11.2 审查 L1）
 */
function removeEntry(file: string): void {
  if (!lstatSync(file).isSymbolicLink()) {
    rmSync(file, { force: true });
    return;
  }
  try {
    unlinkSync(file);
  } catch {
    rmdirSync(file);
  }
}

export interface SyncResult {
  dir: string;
  written: string[];
  removed: string[];
}

export function syncCodexPackage(source: string = paths.codexProviderSource): SyncResult {
  try {
    const result = sync(source);
    lastSyncError = null;
    return result;
  } catch (error) {
    lastSyncError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

function sync(source: string): SyncResult {
  const target = installedCodexPackageDir();
  const files = codexPackageFiles(source);
  assertNoLink(target);
  mkdirSync(path.join(target, "src"), { recursive: true });
  assertNoLink(path.join(target, "src"));

  const written: string[] = [];
  for (const rel of files) {
    const from = path.join(source, ...rel.split("/"));
    const to = path.join(target, ...rel.split("/"));
    const bytes = readFileSync(from);
    // lstat 目标本身：悬空的文件链接 existsSync 是 false，直接写会顺着它写到数据根外面（11.2 第二轮审查 L-b）
    let current: ReturnType<typeof lstatSync> | undefined;
    try {
      current = lstatSync(to);
    } catch {
      current = undefined;
    }
    if (current?.isFile() && readFileSync(to).equals(bytes)) continue;
    if (current) removeEntry(to);
    writeFileSync(to, bytes);
    written.push(rel);
  }
  const keep = new Set(files);
  const removed: string[] = [];
  for (const rel of listFiles(target)) {
    if (keep.has(rel)) continue;
    removeEntry(path.join(target, ...rel.split("/")));
    removed.push(rel);
  }
  return { dir: target, written, removed };
}
