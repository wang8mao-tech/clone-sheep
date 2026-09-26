import { spawn } from "node:child_process";
import { which } from "./which.js";

/**
 * 替换素材图用的 ffprobe / ffmpeg（REQ-005：替换单张图时保持文件名与尺寸规范）。
 * 不加图片库：ffmpeg / ffprobe 本来就是体检必过项（证据准备、出片校验都靠它）。
 * 只 spawn 真 exe、不经 shell：参数里有文件路径，批处理垫片要走 cmd.exe，那条路不给带路径的参数用。
 */

export class ImageToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImageToolError";
  }
}

const TIMEOUT_MS = 60_000;

export function resolveTool(name: "ffmpeg" | "ffprobe"): string {
  const found = which(name);
  if (!found) throw new ImageToolError("TOOL_MISSING", `${name} 不在 PATH，先在设置页的环境体检里装好`);
  if (found.isBatch) throw new ImageToolError("TOOL_MISSING", `${name} 是批处理垫片（${found.path}），需要真正的 exe`);
  return found.path;
}

export function run(
  exe: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageInfo extends ImageSize {
  /** ffprobe 的 codec_name：jpg 是 mjpeg，另有 png、webp 等 */
  codec: string;
}

/** 失败原因的一行：超时单独说，别只剩一个冒号 */
function firstLine(out: { stderr: string; timedOut: boolean }): string {
  if (out.timedOut) return `超过 ${TIMEOUT_MS / 1000} 秒没做完，已停下`;
  return out.stderr.trim().split("\n")[0] || "没有输出";
}

/** 读一张图的宽高与编码；读不出（不是图、文件坏了）抛 ImageToolError，what 说清读的是哪张 */
export async function probeImage(file: string, what = "这张图"): Promise<ImageInfo> {
  const out = await run(resolveTool("ffprobe"), [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,codec_name",
    "-of",
    "json",
    file,
  ]);
  if (out.code !== 0) throw new ImageToolError("NOT_AN_IMAGE", `读不出${what}：${firstLine(out)}`);
  let parsed: { streams?: Array<{ width?: number; height?: number; codec_name?: string }> };
  try {
    parsed = JSON.parse(out.stdout) as typeof parsed;
  } catch {
    throw new ImageToolError("NOT_AN_IMAGE", `读不出${what}：ffprobe 的输出不是 JSON`);
  }
  const s = parsed.streams?.[0];
  if (!s?.width || !s.height) throw new ImageToolError("NOT_AN_IMAGE", `读不出${what}的宽高`);
  return { width: s.width, height: s.height, codec: s.codec_name ?? "" };
}

/**
 * 把 input 缩放并居中裁切成 size，写到 output（格式按 output 的扩展名）。
 * 先按比例放大到盖满，再裁掉多出来的：不拉伸变形，和 Agent 统一裁切的做法一致
 */
export async function fitImage(input: string, output: string, size: ImageSize): Promise<void> {
  const { width: w, height: h } = size;
  const out = await run(resolveTool("ffmpeg"), [
    "-y",
    "-v",
    "error",
    "-i",
    input,
    "-vf",
    `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    // 单张输出：不让 image2 把文件名里的 %d 当成序号模板展开（8.2 审查 L1）
    "-update",
    "1",
    output,
  ]);
  if (out.code !== 0) throw new ImageToolError("CONVERT_FAILED", `转换图片失败：${firstLine(out)}`);
}
