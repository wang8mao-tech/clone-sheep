import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { init, success } from "../agent/scheduler-test-kit.js";
import { boot, until } from "./clone-test-kit.js";

/**
 * 变体测试的公共底座：在复刻的 boot() 上把模板置为已验货、放好模板原稿，接上变体编排。
 * 调用方自己 useCloneSandbox()（每个用例一个临时数据根）。
 */

export const TEMPLATE_RUN = "# reference.svrun\n";

export async function bootVariants() {
  const b = await boot();
  b.db().prepare("UPDATE templates SET status = 'approved', language = 'zh' WHERE id = ?").run(b.templateId);
  for (const file of ["reference.svml", "reference.svs", "reference.svrun"]) {
    writeFileSync(path.join(b.workspace, file), `# ${file}\n`, "utf8");
  }
  const flow = await import("./variant-flow.js");
  const unregisterFlow = flow.registerVariantFlow();
  const variants = await import("./variants.js");
  const vstore = await import("./variant-store.js");
  const files = await import("./variant-files.js");

  const dirOf = (id: string) => files.variantDir(b.workspace, id);
  const statusOf = (id: string) =>
    (b.db().prepare("SELECT status FROM productions WHERE id = ?").get(id) as { status: string } | undefined)?.status;
  /** 第 i 个假会话属于哪条变体（会话的工作目录就是变体目录） */
  const ownerOfCall = (i: number) => path.basename(b.calls[i]?.input.workspace ?? "");

  return {
    ...b,
    flow,
    unregisterFlow,
    variants,
    vstore,
    files,
    dirOf,
    statusOf,
    ownerOfCall,
    submit: (lines: readonly string[], extra: Partial<Parameters<typeof variants.submitBatch>[1]> = {}) =>
      variants.submitBatch(b.templateId, { briefs: lines.join("\n"), ...extra }),
    /** 在变体目录写一套能过判据的产物；sources 不给就是两张有来源的图 */
    writeProducts: (
      id: string,
      options: { sources?: unknown; script?: boolean; run?: boolean; images?: readonly string[] } = {},
    ) => {
      const dir = dirOf(id);
      mkdirSync(path.join(dir, "assets"), { recursive: true });
      const images = options.images ?? ["assets/01-a.jpg", "assets/02-b.jpg"];
      for (const img of images) writeFileSync(path.join(dir, img), "jpg", "utf8");
      if (options.run !== false) writeFileSync(path.join(dir, "variant.svrun"), "# variant\n", "utf8");
      if (options.script !== false) writeFileSync(path.join(dir, "SCRIPT.md"), "# 台词\n第一段\n", "utf8");
      const sources =
        "sources" in options
          ? options.sources
          : {
              assets: [
                { file: "assets/01-a.jpg", label: "A", sourceUrl: "https://example.com/a", width: 100, height: 100 },
                { file: "assets/02-b.jpg", label: "B", sourceUrl: "https://example.com/b", width: 100, height: 100 },
              ],
            };
      if (sources !== null) writeFileSync(path.join(dir, "SOURCES.json"), JSON.stringify(sources), "utf8");
    },
    /** 让第 i 个假会话以成功收尾，等它的任务离开「运行中」 */
    finishCall: async (i: number, cost = 0.2) => {
      await until(() => b.calls.length > i, `第 ${i + 1} 个会话开跑`);
      const call = b.calls[i] as (typeof b.calls)[number];
      const owner = path.basename(call.input.workspace);
      call.input.onMessage(init(`s-${owner}-${i}`) as never);
      call.finish({ sessionId: `s-${owner}-${i}`, result: success(cost) as never });
      await until(() => b.store.latestJobOf("production", owner)?.status !== "running", "任务结束");
      return owner;
    },
  };
}

/** 「本机订阅 · 指定模型」档案（Sonnet）：替代 Phase 8 的按模型 id 提交（REQ-010） */
export async function sonnetProfile(): Promise<string> {
  const { createProfile } = await import("../agent/profiles.js");
  return createProfile({
    name: "订阅 · Sonnet",
    kind: "subscription",
    modelId: "claude-sonnet-5",
    supportsVision: true,
    supportsWebSearch: true,
  }).id;
}

export type BootedVariants = Awaited<ReturnType<typeof bootVariants>>;
