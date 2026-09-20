import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { runHypit } from "../hypit/cli.js";
import { checkProbe, STEP_TIMEOUT_MS, transcribeNote, type EvidenceStep, type ProbeFacts } from "./evidence-rules.js";
import { listSteps } from "./evidence-store.js";
import { EvidenceError, type StartArgs } from "./evidence.js";

/**
 * 四步各自怎么跑。编排（顺序、重试、状态落库）在 evidence.ts，这里只管
 * 「这一步具体调 hypit 的哪条命令、产物写到哪」。
 *
 * 拆开是因为两件事变化的原因不同：编排跟着 REQ-002 的状态机走，这里跟着
 * hypit 的命令行接口走。
 */

export interface StepContext extends StartArgs {
  workspace: string;
}

/** 抽多少帧。取整条片子均匀分布的中点，够 Agent 看清结构又不至于拼图太多。 */
const TILE_FRAMES = 24;

export async function execute(step: EvidenceStep, ctx: StepContext): Promise<unknown> {
  const sourcePath = path.join(ctx.workspace, "references", "src", "source.mp4");
  switch (step) {
    case "fetch":
      return fetchSource(ctx, sourcePath);
    case "probe":
      return probe(ctx, sourcePath);
    case "transcribe":
      return transcribe(ctx, sourcePath);
    case "tiles":
      return tiles(ctx, sourcePath);
  }
}

/** 上传的直接搬进工作目录；链接的交给 hypit 拉（它用的是钉死版本的 yt-dlp） */
async function fetchSource(ctx: StepContext, sourcePath: string): Promise<unknown> {
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  // hypit media fetch 拒绝覆盖已有文件，重试前必须先清掉
  rmSync(sourcePath, { force: true });

  if (ctx.source.kind === "file") {
    const from = ctx.source.path;
    if (!existsSync(from)) {
      throw new EvidenceError("UPLOAD_GONE", "上传的文件已经不在了，请重新上传。", 409);
    }
    // 同盘就 rename（省一次整片拷贝），跨盘退回 copy
    try {
      renameSync(from, sourcePath);
    } catch {
      copyFileSync(from, sourcePath);
      rmSync(from, { force: true });
    }
    recordSourcePath(ctx.templateId, sourcePath);
    return { kind: "file" };
  }

  // 先把钉死版本的 yt-dlp 备好。不备的话第一次贴链接会撞上
  // 「yt-dlp … is not ready; run hypit media prepare-fetch」——那句话对用户
  // 毫无意义，他并不知道 yt-dlp 是什么。装过就是毫秒级返回，可以每次都调
  await runHypit<unknown>(["media", "prepare-fetch", "--json"], {
    cwd: ctx.workspace,
    subject: { kind: "template", id: ctx.templateId },
    timeoutMs: STEP_TIMEOUT_MS,
  });

  const result = await runHypit<unknown>(["media", "fetch", ctx.source.url, "--to", sourcePath, "--json"], {
    cwd: ctx.workspace,
    subject: { kind: "template", id: ctx.templateId },
    timeoutMs: STEP_TIMEOUT_MS,
  });
  recordSourcePath(ctx.templateId, sourcePath);
  return result.json;
}

async function probe(ctx: StepContext, sourcePath: string): Promise<ProbeFacts> {
  const result = await runHypit<ProbeFacts>(["media", "probe", sourcePath, "--json"], {
    cwd: ctx.workspace,
    subject: { kind: "template", id: ctx.templateId },
    timeoutMs: STEP_TIMEOUT_MS,
  });

  const verdict = checkProbe(result.json);
  if (!verdict.ok) throw new EvidenceError(verdict.code, verdict.message, 400);
  return result.json;
}

async function transcribe(ctx: StepContext, sourcePath: string): Promise<unknown> {
  const to = path.join(ctx.workspace, "references", "transcript.json");
  rmSync(to, { force: true });

  const result = await runHypit<unknown>(
    ["transcribe", sourcePath, "--to", to, "--language", ctx.language, "--workspace", ctx.workspace, "--json"],
    {
      cwd: ctx.workspace,
      subject: { kind: "template", id: ctx.templateId },
      timeoutMs: STEP_TIMEOUT_MS,
    },
  );

  const facts = listSteps(ctx.templateId).find((s) => s.step === "probe")?.detail as ProbeFacts | undefined;
  const note = facts ? transcribeNote(facts) : undefined;
  return { ...(result.json as Record<string, unknown>), ...(note ? { note } : {}) };
}

async function tiles(ctx: StepContext, sourcePath: string): Promise<unknown> {
  const to = path.join(ctx.workspace, "references", "tiles");
  // tiles 拒绝写进已有内容，重试前清干净
  rmSync(to, { recursive: true, force: true });

  const transcript = path.join(ctx.workspace, "references", "transcript.json");
  const args = ["media", "tiles", sourcePath, "--frames", String(TILE_FRAMES), "--to", to, "--json"];
  // 没有转写结果就不带 --transcript：带了会让 hypit 去读一个不存在的文件
  if (existsSync(transcript)) args.splice(args.length - 1, 0, "--transcript", transcript);

  const result = await runHypit<unknown>(args, {
    cwd: ctx.workspace,
    subject: { kind: "template", id: ctx.templateId },
    timeoutMs: STEP_TIMEOUT_MS,
  });
  return result.json;
}

function recordSourcePath(templateId: string, sourcePath: string): void {
  db()
    .prepare("UPDATE templates SET source_path = ?, updated_at = ? WHERE id = ?")
    .run(sourcePath, new Date().toISOString(), templateId);
}
