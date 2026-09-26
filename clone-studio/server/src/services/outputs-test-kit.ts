import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * ⑤ 成片库测试的装置（Task 9.1）：临时数据根里建一个客户、一个模板，直接往库里造出片单位、出片记录与 Agent 任务，
 * 成片文件写在模板工作目录的 output/ 下。不起执行器、不跑 hypit：成片库只读台账与文件。
 */

let dataRoot = "";
let closeDb: (() => void) | undefined;
/** 列表会起后台抽取：拆环境前先等它们跑完，免得关库、删目录之后它还在写（用例之间串扰、留下临时目录） */
let metaIdle: (() => Promise<void>) | undefined;

export function useOutputsSandbox(): void {
  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(tmpdir(), "cs-out-"));
    process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
    vi.resetModules();
  });
  afterEach(async () => {
    await metaIdle?.();
    metaIdle = undefined;
    closeDb?.();
    closeDb = undefined;
    rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.CLONE_STUDIO_DATA_ROOT;
    vi.restoreAllMocks();
  });
}

/** 真 mp4（ffmpeg 生成，160×284、给定秒数）：抽帧与时长要真文件 */
export function realMp4(file: string, seconds = 3): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const out = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=160x284:rate=10`,
      "-t",
      String(seconds),
      "-pix_fmt",
      "yuv420p",
      file,
    ],
    { windowsHide: true },
  );
  if (out.status !== 0) throw new Error(`ffmpeg 生成测试视频失败：${String(out.stderr)}`);
}

let clock = Date.parse("2026-09-25T08:00:00.000Z");
const tick = () => new Date((clock += 1000)).toISOString();

export async function bootOutputs() {
  if (!process.env.CLONE_STUDIO_DATA_ROOT?.startsWith(tmpdir())) throw new Error("数据根不在临时目录，拒绝跑");
  const dbMod = await import("../db/index.js");
  closeDb = dbMod.closeDb;
  (await import("../db/migrate.js")).migrate();
  const archive = await import("./archive.js");
  const outputs = await import("./outputs.js");
  const costs = await import("./output-costs.js");
  const del = await import("./output-delete.js");
  const zip = await import("./output-zip.js");
  const meta = await import("./output-meta.js");
  metaIdle = meta.metaIdle;
  const client = archive.createClient("客户");
  const template = archive.createTemplate(client.id, "手机榜");
  const workspace = template.workspace_path as string;
  const d = dbMod.db();

  function production(
    over: {
      kind?: "replica" | "variant";
      status?: string;
      name?: string | null;
      version?: number;
      runPath?: string | null;
      templateId?: string;
    } = {},
  ): string {
    const id = randomUUID();
    const at = tick();
    d.prepare(
      `INSERT INTO productions (id, template_id, kind, name, version, run_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      over.templateId ?? template.id,
      over.kind ?? "variant",
      over.name === undefined ? "变体" : over.name,
      over.version ?? 1,
      over.runPath === undefined ? "productions/x/variant.svrun" : over.runPath,
      over.status ?? "done",
      at,
      at,
    );
    return id;
  }

  /** 出片记录；file 给字符串就把它写成成片文件内容，给 "real" 就用 ffmpeg 生成真视频，给 null 不写文件 */
  function build(
    productionId: string,
    over: {
      status?: string;
      file?: string | null;
      name?: string;
      estimate?: number | null;
      actual?: number | null;
      receiptUrl?: string | null;
      outputPath?: string;
    } = {},
  ): { id: string; output: string } {
    const id = randomUUID();
    const output = over.outputPath ?? path.join(workspace, "output", `${over.name ?? id.slice(0, 8)}.mp4`);
    const file = over.file === undefined ? "fake mp4" : over.file;
    if (file === "real") realMp4(output);
    else if (file !== null) {
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, file, "utf8");
    }
    d.prepare(
      `INSERT INTO builds (id, production_id, status, estimate_usd, actual_usd, receipt_url, output_path, hypit_build_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      productionId,
      over.status ?? "done",
      over.estimate === undefined ? 0.4 : over.estimate,
      over.actual ?? null,
      over.receiptUrl ?? null,
      output,
      `bld_${id.slice(0, 6)}`,
      tick(),
    );
    return { id, output };
  }

  function job(
    ownerKind: "template" | "production",
    ownerId: string,
    costUsd: number,
    over: { model?: string; elapsedMs?: number } = {},
  ): string {
    const id = randomUUID();
    d.prepare(
      `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, cost_usd, model_id, run_elapsed_ms, created_at)
       VALUES (?, ?, ?, 'done', ?, ?, ?, ?)`,
    ).run(id, ownerKind, ownerId, costUsd, over.model ?? "claude-sonnet-5", over.elapsedMs ?? 60_000, tick());
    return id;
  }

  async function app() {
    const Fastify = (await import("fastify")).default;
    const server = Fastify();
    await server.register((await import("../routes/outputs.js")).outputRoutes);
    await server.register((await import("../routes/review.js")).reviewRoutes);
    return server;
  }

  return { d, archive, outputs, costs, del, zip, meta, template, workspace, dataRoot, production, build, job, app };
}

export type BootedOutputs = Awaited<ReturnType<typeof bootOutputs>>;
