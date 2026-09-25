import { rmSync } from "node:fs";
import { db } from "../db/index.js";
import { ImageToolError, resolveTool, run } from "../lib/image-tool.js";

/**
 * ⑤ 成片的时长与封面帧（REQ-007）：ffprobe 读时长、ffmpeg 抽一帧缩到 360 宽存在成片旁边，缓存到 builds 上。
 *
 * - 在后台取：网格先拿缓存（没有就给占位），取完由调用方推事件让页面重拉；不让列表接口等 ffmpeg。
 * - 同时最多跑 2 个：本机渲染本来就吃内存（REQ-006 workers 只敢开 1），第一次打开几十条成片不能一口气起几十个 ffmpeg。
 * - 只缓存确定的结论：工具跑了、文件就是读不出（坏文件）才记下检查时间不再重试；工具不在、起不来、超时
 *   都是会好的（装上 ffmpeg、机器闲下来），不记，下次打开再试（9.1 审查 S2-3）。
 */

export interface OutputMeta {
  durationS: number | null;
  coverPath: string | null;
}

interface MetaRow {
  id: string;
  production_id: string;
  output_path: string | null;
  duration_s: number | null;
  cover_path: string | null;
  meta_checked_at: string | null;
}

/** 封面文件：成片旁边同名加后缀，删除成片时一起删 */
export function coverPathFor(outputPath: string): string {
  return `${outputPath}.cover.jpg`;
}

/** 取不到、但过一会儿可能就好了（工具不在 / 起不来 / 超时）：不缓存 */
class Transient extends Error {}

const MAX_PARALLEL = 2;
let active = 0;
const waiting: Array<() => void> = [];
const inflight = new Map<string, Promise<OutputMeta | null>>();
/** 已经拿到名额、正在跑工具的（删成片只等这些：还在排队的起来时会看到文件没了、成片已删，自己收手） */
const started = new Set<string>();

/** 名额直接交给下一个排队的（不先还再抢）：同一轮微任务里新来的不会插进来多占一个（9.1 第五轮审查 S2-L4） */
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

function readRow(buildId: string): MetaRow | undefined {
  return db()
    .prepare("SELECT id, production_id, output_path, duration_s, cover_path, meta_checked_at FROM builds WHERE id = ?")
    .get(buildId) as MetaRow | undefined;
}

/** 缓存里有就给；没取过返回 null（调用方给占位，并用 ensureOutputMeta 在后台取） */
export function cachedOutputMeta(buildId: string): OutputMeta | null {
  const row = readRow(buildId);
  if (!row?.meta_checked_at) return null;
  return { durationS: row.duration_s, coverPath: row.cover_path };
}

/**
 * 取一条 build 的时长与封面。已缓存直接给；同一条并发来取只跑一次。
 * 返回 null = 这次没取成、也没缓存（暂时性失败，或取的过程中成片被删了）
 */
export function ensureOutputMeta(buildId: string): Promise<OutputMeta | null> {
  const row = readRow(buildId);
  if (!row?.output_path) return Promise.resolve(null);
  if (row.meta_checked_at) return Promise.resolve({ durationS: row.duration_s, coverPath: row.cover_path });
  const running = inflight.get(buildId);
  if (running) return running;
  const outputPath = row.output_path;
  const job = slot(() => {
    started.add(buildId);
    return extract(row.id, row.production_id, outputPath);
  }).finally(() => {
    started.delete(buildId);
    inflight.delete(buildId);
  });
  inflight.set(buildId, job);
  return job;
}

/** 等这几条 build 正在跑的抽取结束（删成片前：ffmpeg 开着文件时 Windows 删不掉） */
export async function settleMeta(buildIds: readonly string[]): Promise<void> {
  const running = buildIds.flatMap((id) => {
    const job = started.has(id) ? inflight.get(id) : undefined;
    return job ? [job] : [];
  });
  await Promise.allSettled(running);
}

/** 测试用：等后台的抽取都跑完 */
export async function metaIdle(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight.values()]);
}

async function extract(buildId: string, productionId: string, outputPath: string): Promise<OutputMeta | null> {
  let meta: OutputMeta;
  try {
    const durationS = await probeDuration(outputPath);
    meta = { durationS, coverPath: await grabCover(outputPath, durationS) };
  } catch (error) {
    if (error instanceof Transient) return null;
    throw error;
  }
  // 取的时候成片被删了：别把封面留成孤儿，也别往一条已删的成片上回写（9.1 审查 S2-11）
  const deleted = db().prepare("SELECT output_deleted_at FROM productions WHERE id = ?").get(productionId) as
    { output_deleted_at: string | null } | undefined;
  if (!deleted || deleted.output_deleted_at) {
    if (meta.coverPath) rmSync(meta.coverPath, { force: true });
    return null;
  }
  db()
    .prepare("UPDATE builds SET duration_s = ?, cover_path = ?, meta_checked_at = ? WHERE id = ?")
    .run(meta.durationS, meta.coverPath, new Date().toISOString(), buildId);
  return meta;
}

/** 跑一个工具：工具不在、起不来、超时都是暂时性的 */
async function tool(name: "ffmpeg" | "ffprobe", args: readonly string[]) {
  let exe: string;
  try {
    exe = resolveTool(name);
  } catch (error) {
    if (error instanceof ImageToolError) throw new Transient(error.message);
    throw error;
  }
  let out;
  try {
    out = await run(exe, args);
  } catch (error) {
    throw new Transient(String(error));
  }
  if (out.timedOut) throw new Transient(`${name} 超时`);
  return out;
}

async function probeDuration(file: string): Promise<number | null> {
  const out = await tool("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const value = Number(out.stdout.trim());
  return out.code === 0 && Number.isFinite(value) && value > 0 ? value : null;
}

/** 抽第 1 秒（片子不到 2 秒就取中间）那一帧；读不出删掉可能写了一半的文件，返回 null */
async function grabCover(file: string, durationS: number | null): Promise<string | null> {
  const target = coverPathFor(file);
  const at = durationS !== null && durationS < 2 ? durationS / 2 : 1;
  try {
    const out = await tool("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-ss",
      at.toFixed(2),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale=360:-2",
      "-update",
      "1",
      target,
    ]);
    if (out.code === 0) return target;
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
  rmSync(target, { force: true });
  return null;
}
