import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { isInside, realpathOrUndefined } from "../lib/safe-path.js";
import { EvidenceError } from "../services/evidence-types.js";
import { parseRange } from "./range.js";

/**
 * 把数据根里的一个视频文件按 Range 发给播放器：参考视频（① / ② / ③ 左路）与复刻片（③ 右路）共用。
 * 拖进度条靠单段 `bytes=`（range.ts），多段不支持。
 */
export async function sendVideoFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: string,
  notFound: EvidenceError,
  /** 文件确实打开了才加的响应头（下载的 Content-Disposition：出错时别让浏览器把错误 JSON 存成 mp4） */
  headers: Record<string, string> = {},
): Promise<FastifyReply> {
  const handle = await openInsideDataRoot(file, notFound);
  let handedOff = false;
  try {
    // 大小从同一个 fd 上取：先 stat 路径再开流，中间文件被重新导入删掉时
    // 会冒出一个带绝对路径的 500 ENOENT（审查 S7）
    const info = await handle.stat();
    // 文件被换成了目录之类：当作没有，别让 read 冒出 500 EISDIR（复审 Q4）
    if (!info.isFile()) throw notFound;
    for (const [name, value] of Object.entries(headers)) void reply.header(name, value);
    const size = info.size;
    void reply.header("Accept-Ranges", "bytes");
    // 工作目录里的文件会随重新导入 / 重出而变，别让浏览器缓存住旧的
    void reply.header("Cache-Control", "no-store");

    const range = parseRange(request.headers.range, size);
    if (range === "invalid") {
      void reply.header("Content-Range", `bytes */${size}`);
      return reply.status(416).send();
    }

    void reply.header("Content-Type", await sniffVideoType(handle));
    if (!range) {
      void reply.header("Content-Length", String(size));
      handedOff = true;
      return reply.send(handle.createReadStream());
    }
    void reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    void reply.header("Content-Length", String(range.end - range.start + 1));
    handedOff = true;
    return reply.status(206).send(handle.createReadStream({ start: range.start, end: range.end }));
  } finally {
    // 交给流之后由流负责关（autoClose），没交出去的自己关
    if (!handedOff) await handle.close();
  }
}

/**
 * 只许读数据根目录里的东西，而且比的是真实路径。
 * 路径是从库里的列拼出来的，看着安全；但那些列是可写的，
 * 目录里也可能被放进指向外面的 junction——一个「按路径读文件」的接口漏了
 * 这道判断就是现成的任意文件读取。
 *
 * realpath 与 open 之间有一个 TOCTOU 空当（复审 Q5）：要利用它得先有数据目录的
 * 本地写权限，而服务只绑 127.0.0.1、单机单用户，接受这个假设，不再对 fd 复核。
 */
async function openInsideDataRoot(file: string, notFound: EvidenceError): Promise<FileHandle> {
  const root = path.resolve(config.dataRoot);
  const outside = new EvidenceError("OUTSIDE_DATA_ROOT", "拒绝读取数据目录之外的文件。", 403);
  if (!isInside(root, path.resolve(file))) throw outside;

  const real = realpathOrUndefined(file);
  if (real === undefined) throw notFound;
  if (!isInside(realpathOrUndefined(root) ?? root, real)) throw outside;

  try {
    return await open(real, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound;
    throw error;
  }
}

/**
 * Spec 规定参考视频一律存成 source.mp4，但上传的可能是 webm / mov。按魔数回真实类型，
 * 不指望浏览器替我们嗅探（审查 S6）。
 */
async function sniffVideoType(handle: FileHandle): Promise<string> {
  const head = Buffer.alloc(12);
  const { bytesRead } = await handle.read(head, 0, 12, 0);
  if (bytesRead >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return "video/webm";
  if (bytesRead >= 12 && head.toString("latin1", 4, 8) === "ftyp" && head.toString("latin1", 8, 12) === "qt  ") {
    return "video/quicktime";
  }
  return "video/mp4";
}
