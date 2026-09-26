import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 找 Codex 出的图（REQ-011），两条路互为兜底：
 * 1. `<cwd>/images/<name>.png`：提示词里要求它复制过来的
 * 2. `$CODEX_HOME/generated_images/<thread_id>/` 下修改时间落在本次运行区间里的最新 PNG：
 *    Codex 生成了、但那条复制命令没执行或复制错了地方
 * 只认大小 > 0 的文件：空文件当成没出图，绝不交一张空图给 Build。
 */

/** 文件时间精度与进程启动的误差：区间两头各放宽 2 秒 */
const SLACK_MS = 2_000;

export interface LocateOptions {
  cwd: string;
  name: string;
  codexHome: string;
  threadId: string | undefined;
  startedAt: number;
  endedAt: number;
}

export interface Located {
  file: string;
  via: "images" | "generated_images";
}

function nonEmptyFile(file: string): { size: number; mtimeMs: number } | undefined {
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size > 0 ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

export function locateImage(options: LocateOptions): Located | undefined {
  const copied = path.join(options.cwd, "images", `${options.name}.png`);
  if (nonEmptyFile(copied)) return { file: copied, via: "images" };
  if (options.threadId === undefined || !/^[A-Za-z0-9_-]+$/u.test(options.threadId)) return undefined;

  const dir = path.join(options.codexHome, "generated_images", options.threadId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { file: string; mtimeMs: number } | undefined;
  for (const entry of names) {
    if (!/\.png$/iu.test(entry)) continue;
    const file = path.join(dir, entry);
    const stat = nonEmptyFile(file);
    if (!stat) continue;
    if (stat.mtimeMs < options.startedAt - SLACK_MS || stat.mtimeMs > options.endedAt + SLACK_MS) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
  }
  return best ? { file: best.file, via: "generated_images" } : undefined;
}
