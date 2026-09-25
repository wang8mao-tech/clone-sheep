import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { canonicalize, defineEndpointPackage } from "@hypit/hypit/endpoint-kit";
import type { EndpointInvocationContext, EndpointRequest, EndpointSupport } from "@hypit/hypit/endpoint-kit";
import { generationTypes, sealGeneratedImageSet } from "@hypit/hypit/generation";
import type { GenerationMediaValue, GenerationPortValue, GenerationRequest } from "@hypit/hypit/generation";
import { DEFAULT_TIMEOUT_MS, MAX_REFERENCES, quotaMessage, runCodex, type CodexRun } from "./codex-runner.js";
import { locateImage } from "./locate-image.js";
import { clip, MAX_ERROR_CHARS, MAX_TAIL_LINE_CHARS } from "./jsonl.js";
import { buildPrompt } from "./prompt.js";

/**
 * Codex 订阅生图 Provider（REQ-011）：承接 `@hypit/gpt-image@1#gpt-image-2`，每个请求起一次本机 Codex，
 * 由 `$imagegen` 出图，PNG 交回 Build。本机进程、同步出结果，所以是 immediate endpoint；零价（local）。
 */

export const providerModule = { name: "@clone-studio/codex-image", version: "1" } as const;
export const capability = { module: { name: "@hypit/gpt-image", version: "1" }, name: "gpt-image-2" } as const;

const PORTS = new Set(["prompt", "aspectRatio", "resolution", "background", "images"]);
/** 产物文件名：临时目录每次新建，固定名就够 */
const IMAGE_NAME = "codex-image";

export interface CodexImageOptions {
  instance: string;
  pool: string;
  /** 起 codex 的可执行文件与前置参数（`.cmd` 垫片由宿主解析成 node + codex.js） */
  command: string;
  prefixArgs?: readonly string[];
  /** 不给就用环境里的 CODEX_HOME，再没有就是 ~/.codex */
  codexHome?: string;
  timeoutMs?: number;
  concurrency?: number;
  /** 测试替换 */
  run?: typeof runCodex;
  /** 删临时目录；测试替换（模拟 Windows 上被占用时的 EPERM） */
  removeDir?: (dir: string) => void;
}

/** 有进程还占着目录时 Windows 会 EPERM：多试几次，给刚被杀的进程一点退场时间 */
function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function portsOf(request: EndpointRequest): GenerationRequest["ports"] {
  return (request.constraints as unknown as GenerationRequest).ports;
}

export function support(request: EndpointRequest): EndpointSupport {
  const ports = portsOf(request);
  const unknown = Object.keys(ports).find((port) => !PORTS.has(port));
  if (unknown) return { status: "unsupported", reason: `Codex 生图不支持 ${unknown} 这个参数` };
  if (ports.background?.[0] === "transparent") {
    return { status: "unsupported", reason: "Codex 生图不支持透明背景" };
  }
  const pending = request.pendingInputs?.filter((slot) => slot.input === "images").length ?? 0;
  const references = (ports.images?.length ?? 0) + pending;
  if (references > MAX_REFERENCES) {
    return { status: "unsupported", reason: `Codex 生图最多带 ${MAX_REFERENCES} 张参考图，这里有 ${references} 张` };
  }
  const other = request.pendingInputs?.find((slot) => !PORTS.has(slot.input));
  if (other) return { status: "unsupported", reason: `Codex 生图不支持 ${other.input} 这个参数` };
  return { status: "supported" };
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** 参考图文件的扩展名：常见的查表，别的取子类型（image/gif → gif），认不出才用 bin（11.1 审查 LOW-6） */
export function referenceExtension(mediaType: string): string {
  return EXTENSIONS[mediaType] ?? /^image\/([a-z0-9]+)$/iu.exec(mediaType)?.[1]?.toLowerCase() ?? "bin";
}

/** 按文件头认图片类型；认不出就不是我们要的图 */
export function imageMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const riff = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  if (riff.startsWith("RIFF") && riff.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** 标量端口的值（prompt / aspectRatio / resolution / background）；媒体项不会出现在这些端口上 */
function scalar(value: GenerationPortValue | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "object") throw fail("CODEX_REQUEST", "请求里的文字参数不是文字");
  return String(value);
}

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** 这次运行没交出图的原因；交出了就是 undefined */
export function runFailure(run: CodexRun): Error | undefined {
  const tail = run.events.tail.join("\n");
  if (run.streamError) return fail("CODEX_OUTPUT", run.streamError);
  if (run.timedOut) return fail("CODEX_TIMEOUT", `Codex 超时没出图，已结束进程。JSONL 末段：\n${tail}`);
  if (run.events.errors.length > 0) return fail("CODEX_ERROR", `Codex 报错：${run.events.errors.join("\n")}`);
  const quota = quotaMessage(run.stderr);
  if (quota) return fail("CODEX_QUOTA", `Codex 额度或限流：${clip(quota, MAX_ERROR_CHARS)}`);
  if (run.exitCode !== 0) {
    const stderr = run.stderr
      .trim()
      .split(/\r?\n/u)
      .slice(-8)
      .map((line) => clip(line, MAX_TAIL_LINE_CHARS))
      .join("\n");
    return fail("CODEX_EXIT", `Codex 退出码 ${String(run.exitCode)}：\n${stderr}\nJSONL 末段：\n${tail}`);
  }
  return undefined;
}

export function createCodexImageProvider(options: CodexImageOptions) {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  const run = options.run ?? runCodex;

  async function handler(context: EndpointInvocationContext) {
    const supported = support(context.need);
    if (supported.status === "unsupported") throw fail("CODEX_UNSUPPORTED", supported.reason);
    const ports = portsOf(context.need);
    const cwd = mkdtempSync(path.join(tmpdir(), "cs-codex-"));
    try {
      const images: string[] = [];
      for (const [index, item] of (ports.images ?? []).entries()) {
        const media = item as GenerationMediaValue;
        const bytes = await context.resources.get(media.artifact.resource);
        if (bytes === undefined) throw fail("CODEX_REFERENCE", `第 ${index + 1} 张参考图读不到`);
        const file = path.join(cwd, `reference-${index + 1}.${referenceExtension(media.artifact.mediaType)}`);
        writeFileSync(file, bytes);
        images.push(file);
      }
      const prompt = buildPrompt({
        prompt: scalar(ports.prompt?.[0], ""),
        aspectRatio: scalar(ports.aspectRatio?.[0], "auto"),
        resolution: scalar(ports.resolution?.[0], "1K"),
        ...(ports.background?.[0] === undefined ? {} : { background: scalar(ports.background[0], "auto") }),
        references: images.length,
        name: IMAGE_NAME,
      });
      await context.reportProgress?.({ phase: "Codex 出图中" });
      const result = await run({
        command: options.command,
        prefixArgs: options.prefixArgs ?? [],
        cwd,
        images,
        prompt,
        env: { ...process.env, CODEX_HOME: codexHome },
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const failure = runFailure(result);
      if (failure) throw failure;
      const found = locateImage({
        cwd,
        name: IMAGE_NAME,
        codexHome,
        threadId: result.events.threadId,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
      });
      if (!found) {
        throw fail(
          "CODEX_NO_IMAGE",
          `Codex 正常退出，但没有产出图片（./images 与 generated_images 都没有）。JSONL 末段：\n${result.events.tail.join("\n")}`,
        );
      }
      const bytes = new Uint8Array(readFileSync(found.file));
      const mediaType = imageMediaType(bytes);
      if (!mediaType) throw fail("CODEX_NOT_IMAGE", `Codex 交出的文件不是图片：${path.basename(found.file)}`);
      const artifact = await context.resources.put(bytes, mediaType);
      await context.reportDiagnostic?.({
        level: "info",
        message: `Codex 出图 1 张（thread ${result.events.threadId ?? "未知"}，经 ${found.via}）`,
      });
      return { value: { kind: "inline" as const, value: canonicalize(sealGeneratedImageSet({ images: [artifact] })) } };
    } finally {
      // 清理失败不能盖掉原来的结果：成功的图已经交出，失败的原文要原样进 Build 错误（11.1 审查 M1）
      try {
        (options.removeDir ?? removeTempDir)(cwd);
      } catch (error) {
        await context
          .reportDiagnostic?.({
            level: "warning",
            message: `Codex 的临时目录没删掉：${cwd}（${error instanceof Error ? error.message : String(error)}）`,
          })
          .catch(() => {
            /* 诊断没记上也不改变结果 */
          });
      }
    }
  }

  return defineEndpointPackage({
    module: providerModule,
    facet: "images",
    instance: options.instance,
    pool: options.pool,
    // 订阅额度约 40-50 张 / 3 小时，默认一次只出一张
    defaultConcurrency: options.concurrency ?? 1,
    pricing: { kind: "local" },
    capabilities: [
      { capability, returns: generationTypes.imageSet, lifecycle: "immediate", supports: support, handler },
    ],
  });
}
