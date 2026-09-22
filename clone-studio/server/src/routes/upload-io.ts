import { rm } from "node:fs/promises";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyReply, FastifyRequest } from "fastify";
import { EvidenceError } from "../services/evidence-types.js";

/**
 * 上传接口的收尾工具：放弃请求、清残留、排空多余的 part、把 multipart 层的
 * 错误翻成界面能用的 code + message。从 media.ts 拆出来守 300 行上限。
 */

/**
 * 提前离开 parts 循环之后，没读完的请求体没人要了：busboy 还接在请求上，
 * 后面的文件 part 没人消费，背压让 socket 停止读取，从此收不到对端的 FIN；
 * index.ts 又关了连接与请求超时，这个连接会被永远晾着，SIGINT 时 app.close()
 * 一直等它退不出去。不停写的客户端还会让插件把后续字段继续攒进内存
 * （复审第四轮 HIGH-1 / MEDIUM-1 实测）。
 *
 * 响应写完后：把请求从 busboy 上摘下来（插件不再解析、不再攒字段），剩下的
 * 字节直接排空丢弃；宽限期内收完就照常 keep-alive，收不完才销毁连接。
 *
 * 不能写完就立刻 destroy，也不能带 Connection: close（Node 会在写完后马上关
 * socket）：接收缓冲里还有没读的数据时关 socket，TCP 发的是 RST，对端会把
 * 已经到手、还没读的响应一起丢掉——客户端连那条 400 都看不到（实测）。
 */
export const ABANDON_GRACE_MS = 2000;

export function abandonRequest(request: FastifyRequest, reply: FastifyReply): void {
  reply.raw.once("finish", () => {
    const req = request.raw;
    // 已经收完或客户端已经走了：close 早就发过，挂上的定时器永远清不掉
    if (req.complete || req.destroyed) return;
    req.unpipe();
    req.resume();
    // unref：宽限期定时器不该独自撑着进程不退
    const timer = setTimeout(() => req.destroy(), ABANDON_GRACE_MS).unref();
    const clear = (): void => clearTimeout(timer);
    req.once("end", clear).once("close", clear);
  });
}

/** 清掉不要的文件。清不掉（Windows 上被占用）只记日志，别让它盖过原本的错误 */
export async function discard(request: FastifyRequest, file: string | undefined): Promise<void> {
  if (!file) return;
  try {
    await rm(file, { force: true });
  } catch (error) {
    request.log.warn({ err: error, file }, "上传残留文件清不掉，等启动时的过期清理");
  }
}

/**
 * 丢弃一个不要的文件 part。不读完的话 busboy 不会往下解析。
 * 已经结束或已被销毁的流直接返回：它的 end / close 早就发过了，再等就是永远
 */
export async function drain(part: MultipartFile): Promise<void> {
  const file = part.file;
  if (file.destroyed || file.readableEnded) return;
  file.resume();
  await new Promise<void>((resolve) => {
    file.once("end", resolve).once("close", resolve);
  });
}

/**
 * multipart 层的错误给中文和合适的状态码，不把插件或 busboy 的英文原样甩给界面。
 *
 * 除了我们自己的 EvidenceError 和真正的文件系统错误（带 syscall，磁盘满之类，
 * 该是 500），其余都是请求体本身的问题：busboy 的截断错误连 code 都没有，
 * 只能一律归成 400 BAD_MULTIPART（复审 Q2）。
 */
export function uploadError(error: unknown): unknown {
  if (error instanceof EvidenceError) return error;
  const { code, syscall } = error as { code?: string; syscall?: string };
  // 文件系统错误（磁盘满、没权限）：原文是英文且带绝对路径，界面只给 code，
  // 原文进日志（复审 #4）
  if (syscall) return new EvidenceError("UPLOAD_IO", `服务器写入上传文件失败（${code ?? syscall}）。`, 500);
  if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
    return new EvidenceError("NOT_MULTIPART", "上传要用 multipart/form-data。", 400);
  }
  if (code === "FST_REQ_FILE_TOO_LARGE") return new EvidenceError("FILE_TOO_LARGE", "文件太大。", 413);
  // ECONNRESET：客户端在两个 part 之间断开（复审第四轮 LOW-2）
  if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "FST_PREMATURE_CLOSE" || code === "ECONNRESET") {
    return new EvidenceError("UPLOAD_ABORTED", "上传中途断开，已丢弃收到的部分。", 400);
  }
  return new EvidenceError("BAD_MULTIPART", "上传的数据不完整或格式不对，请重新上传。", 400);
}

export function formatMb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MB` : `${bytes} 字节`;
}
