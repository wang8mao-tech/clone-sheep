import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { sealGptImage2Request } from "@hypit/gpt-image";
import type { BlobRef, EndpointInvocationContext } from "@hypit/hypit/endpoint-kit";
import { canonicalize } from "@hypit/hypit/endpoint-kit";
import { generationTypes } from "@hypit/hypit/generation";
import type { GenerationPortValue } from "@hypit/hypit/generation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capability, createCodexImageProvider, referenceExtension } from "../src/provider.js";

/** Provider 生命周期：走 hypit 自己的 EndpointRegistry 解析与调用，codex 是假的，不发任何真实请求 */

const FAKE = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
let root: string;
let home: string;
let log: string;
const saved = { mode: process.env.FAKE_CODEX_MODE, log: process.env.FAKE_CODEX_LOG };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cs-provider-"));
  home = path.join(root, "codex-home");
  log = path.join(root, "calls.jsonl");
  process.env.FAKE_CODEX_LOG = log;
});
afterEach(() => {
  process.env.FAKE_CODEX_MODE = saved.mode;
  process.env.FAKE_CODEX_LOG = saved.log;
  if (saved.mode === undefined) delete process.env.FAKE_CODEX_MODE;
  if (saved.log === undefined) delete process.env.FAKE_CODEX_LOG;
  rmSync(root, { recursive: true, force: true });
});

function provider(extra: Partial<Parameters<typeof createCodexImageProvider>[0]> = {}) {
  return createCodexImageProvider({
    instance: "codex.local",
    pool: "codex.local",
    command: process.execPath,
    prefixArgs: [FAKE],
    codexHome: home,
    timeoutMs: 30_000,
    ...extra,
  });
}

function need(ports: Record<string, readonly GenerationPortValue[]>) {
  return {
    id: "need:codex",
    capability,
    returns: generationTypes.imageSet,
    constraints: canonicalize(sealGptImage2Request(ports)),
    result: "record:codex",
  } as const;
}

async function invoke(
  mode: string,
  ports: Record<string, readonly GenerationPortValue[]>,
  resources = new MemoryResourceStore(),
  extra: Partial<Parameters<typeof createCodexImageProvider>[0]> = {},
) {
  process.env.FAKE_CODEX_MODE = mode;
  const pkg = provider(extra);
  const registry = new EndpointRegistry();
  await pkg.install(registry);
  const n = need(ports);
  const resolved = registry.resolve(n);
  if (resolved.status !== "resolved" || resolved.registration.kind !== "immediate") throw new Error("not immediate");
  const diagnostics: string[] = [];
  const context: EndpointInvocationContext = {
    need: n,
    command: { kind: "fulfill-need", id: "command:codex", need: n },
    resources,
    credentials: {},
    reportDiagnostic: async (d) => {
      diagnostics.push(d.message);
    },
  };
  const fulfilled = await resolved.registration.handler(context);
  return { fulfilled, resources, diagnostics };
}

const basic = { prompt: ["一只红苹果"], aspectRatio: ["9:16"], resolution: ["1K"] };
const tempDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("cs-codex-")).length;

describe("Codex Provider：成功", () => {
  it("./images 里的图进 Build：结果是 generated image-set，字节就是 codex 出的 PNG；诊断记 1 张", async () => {
    const before = tempDirs();
    const { fulfilled, resources, diagnostics } = await invoke("ok", basic);
    expect(fulfilled.value.kind).toBe("inline");
    const images = (fulfilled.value as unknown as { value: { images: BlobRef[] } }).value.images;
    expect(images).toHaveLength(1);
    expect(images[0]?.mediaType).toBe("image/png");
    const bytes = await resources.get(images[0]!.resource);
    expect(Buffer.from(bytes!).subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(diagnostics).toEqual([expect.stringMatching(/出图 1 张.*经 images/u)]);
    expect(tempDirs()).toBe(before);
  });

  it("没复制过来：从 $CODEX_HOME/generated_images/<thread> 兜底拿到图", async () => {
    const { diagnostics } = await invoke("generated", basic);
    expect(diagnostics[0]).toContain("经 generated_images");
  });

  it("断流重连提示不判失败", async () => {
    await expect(invoke("reconnect", basic)).resolves.toBeDefined();
  });

  it("参考图从 resources 取出写成文件、--image 带过去，内容一致", async () => {
    const resources = new MemoryResourceStore();
    const ref = await resources.put(new Uint8Array([7, 8, 9]), "image/jpeg");
    await invoke("ok", { ...basic, images: [{ role: "image", artifact: ref }] }, resources);
    const call = JSON.parse(readFileSync(log, "utf8").trim()) as {
      argv: string[];
      references: string[];
      codexHome: string;
    };
    expect(call.references).toEqual(["070809"]);
    expect(call.argv.find((a) => a.endsWith(".jpg"))).toMatch(/reference-1\.jpg$/u);
    expect(call.codexHome).toBe(home);
  });
});

describe("Codex Provider：失败（原文进 Build 错误，不产生空图）", () => {
  it("AC-032：exit 0 但没出图 → 失败，带 JSONL 末段", async () => {
    const before = tempDirs();
    await expect(invoke("none", basic)).rejects.toThrow(/没有产出图片[\s\S]*我没能生成图片/u);
    expect(tempDirs()).toBe(before);
  });

  it("空文件不算图；不是图片的文件拒", async () => {
    await expect(invoke("empty", basic)).rejects.toMatchObject({ code: "CODEX_NO_IMAGE" });
    await expect(invoke("notimage", basic)).rejects.toMatchObject({ code: "CODEX_NOT_IMAGE" });
  });

  it("JSONL error 事件：即使图出来了也判失败，原文带上", async () => {
    await expect(invoke("error", basic)).rejects.toThrow("stream error: broken pipe");
  });

  it("turn.failed、额度 / 限流、非零退出：各自带原文", async () => {
    await expect(invoke("turnfailed", basic)).rejects.toThrow("model response stream ended unexpectedly");
    await expect(invoke("quota", basic)).rejects.toMatchObject({ code: "CODEX_QUOTA" });
    await expect(invoke("quota", basic)).rejects.toThrow("usage limit");
    await expect(invoke("exit2", basic)).rejects.toThrow(/退出码 2[\s\S]*something broke/u);
  });
});

describe("Codex Provider：supports 与声明", () => {
  it("透明背景、超过 4 张参考图：不支持并写原因；opaque 与 4 张可以", async () => {
    const pkg = provider();
    const offer = pkg.offers[0]!;
    const check = (ports: Record<string, readonly GenerationPortValue[]>) => offer.supports!(need(ports));
    expect(check({ ...basic, background: ["transparent"] })).toEqual({
      status: "unsupported",
      reason: "Codex 生图不支持透明背景",
    });
    expect(check({ ...basic, background: ["opaque"] }).status).toBe("supported");
    const resources = new MemoryResourceStore();
    const ref = await resources.put(new Uint8Array([1]), "image/png");
    const refs = (n: number) => Array.from({ length: n }, () => ({ role: "image" as const, artifact: ref }));
    expect(check({ ...basic, images: refs(4) }).status).toBe("supported");
    expect(check({ ...basic, images: refs(5) })).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("最多带 4 张"),
    });
    expect(
      offer.supports!({ ...need(basic), pendingInputs: Array.from({ length: 5 }, () => ({ input: "images" })) }).status,
    ).toBe("unsupported");
  });

  it("透明背景：hypit 解析时就不选它（plan 阶段拒）；绕过解析直接喂 handler 也拒，不起 codex", async () => {
    process.env.FAKE_CODEX_MODE = "ok";
    const registry = new EndpointRegistry();
    await provider().install(registry);
    const transparent = need({ ...basic, background: ["transparent"] });
    expect(registry.resolve(transparent).status).not.toBe("resolved");
    const resolved = registry.resolve(need(basic));
    if (resolved.status !== "resolved" || resolved.registration.kind !== "immediate") throw new Error("not immediate");
    const context: EndpointInvocationContext = {
      need: transparent,
      command: { kind: "fulfill-need", id: "command:codex", need: transparent },
      resources: new MemoryResourceStore(),
      credentials: {},
    };
    await expect(resolved.registration.handler(context)).rejects.toMatchObject({ code: "CODEX_UNSUPPORTED" });
    expect(() => readFileSync(log)).toThrow();
  });

  it("零价（local），没有凭据槽，默认并发 1", () => {
    const pkg = provider();
    expect(pkg.pricing).toEqual({ kind: "local" });
    expect(pkg.credentials).toEqual([]);
    expect(pkg.offers.map((o) => o.capability)).toEqual([capability]);
  });
});

describe("Codex Provider：清理临时目录失败（11.1 审查 M1）", () => {
  // Windows 上还有进程占着 cwd 时 rmSync 抛 EPERM（审查实测）；记下目录，用例结束自己删
  const left: string[] = [];
  const locked = (dir: string) => {
    left.push(dir);
    throw Object.assign(new Error("EPERM: operation not permitted, rmdir"), { code: "EPERM" });
  };
  afterEach(() => {
    for (const dir of left.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("成功照样成功：图已交出，清理失败只报一条诊断", async () => {
    const { fulfilled, diagnostics } = await invoke("ok", basic, new MemoryResourceStore(), { removeDir: locked });
    expect(fulfilled.value.kind).toBe("inline");
    expect(diagnostics.some((d) => d.includes("临时目录没删掉") && d.includes("EPERM"))).toBe(true);
  });

  it("失败保留原来的原因（AC-032 的 JSONL 末段），不被清理错误盖掉", async () => {
    await expect(invoke("none", basic, new MemoryResourceStore(), { removeDir: locked })).rejects.toThrow(
      /没有产出图片[\s\S]*我没能生成图片/u,
    );
  });
});

describe("Codex Provider：失败原文有总长上限（11.1 审查 M2）", () => {
  it("exit 0 没出图、末段全是几百 KB 的行：Build 错误仍在 64 KB 以内，带着截断标记", async () => {
    const error = await invoke("bignone", basic).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain("没有产出图片");
    expect(error?.message).toContain("截断");
    expect(error!.message.length).toBeLessThan(64 * 1024);
  });

  it("非零退出、stderr 一行上 MB：同样截断", async () => {
    const error = await invoke("bigexit", basic).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain("退出码 2");
    expect(error?.message).toContain("截断");
    expect(error!.message.length).toBeLessThan(64 * 1024);
  });
});

describe("Codex Provider：超时与单行超长进 Build 错误（11.1 审查 LOW-5）", () => {
  it("超时：CODEX_TIMEOUT，带 JSONL 末段", async () => {
    await expect(invoke("hang", basic, new MemoryResourceStore(), { timeoutMs: 800 })).rejects.toMatchObject({
      code: "CODEX_TIMEOUT",
      message: expect.stringContaining("thread.started"),
    });
  });

  it("一行超过 4 MB：CODEX_OUTPUT", async () => {
    await expect(invoke("longline", basic)).rejects.toMatchObject({ code: "CODEX_OUTPUT" });
  });

  it("额度用完的原话与 429 限流：CODEX_QUOTA，原文带上", async () => {
    await expect(invoke("quota", basic)).rejects.toThrow("You've hit your usage limit");
    await expect(invoke("ratelimit", basic)).rejects.toMatchObject({ code: "CODEX_QUOTA" });
    const big = await invoke("bigquota", basic).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(big).toMatchObject({ code: "CODEX_QUOTA" });
    expect(big?.message).toContain("截断");
    expect(big?.message).toContain("You've hit your usage limit");
    expect(big!.message.length).toBeLessThan(64 * 1024);
  });
});

describe("referenceExtension（11.1 审查 LOW-6）", () => {
  it("常见的查表，别的取子类型，认不出用 bin", () => {
    expect(referenceExtension("image/jpeg")).toBe("jpg");
    expect(referenceExtension("image/gif")).toBe("gif");
    expect(referenceExtension("image/avif")).toBe("avif");
    expect(referenceExtension("application/octet-stream")).toBe("bin");
  });
});
