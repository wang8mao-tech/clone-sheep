import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { runHypit } from "../hypit/cli.js";
import { ensureWhisperX } from "../hypit/whisperx-service.js";
import { isReallyInside } from "../lib/safe-path.js";
import { checkProbe, STEP_TIMEOUT_MS, transcribeNote, type EvidenceStep, type ProbeFacts } from "./evidence-rules.js";
import { listSteps, markDone, noteRunning } from "./evidence-store.js";
import { EvidenceError, type StartArgs } from "./evidence-types.js";

/**
 * 四步各自怎么跑。编排（顺序、重试、状态落库）在 evidence.ts，这里只管
 * 「这一步具体调 hypit 的哪条命令、产物写到哪」。
 *
 * 拆开是因为两件事变化的原因不同：编排跟着 REQ-002 的状态机走，这里跟着
 * hypit 的命令行接口走。
 */

export interface StepContext extends StartArgs {
  workspace: string;
  /** 时长上限，来自设置（REQ-008 的 referenceMaxSeconds），不是硬编码 */
  maxSeconds: number;
}

/** 抽多少帧。取整条片子均匀分布的中点，够 Agent 看清结构又不至于拼图太多。 */
const TILE_FRAMES = 24;

export function sourcePathOf(workspace: string): string {
  return path.join(workspace, "references", "src", "source.mp4");
}

export function transcriptPathOf(workspace: string): string {
  return path.join(workspace, "references", "transcript.json");
}

export function tilesDirOf(workspace: string): string {
  return path.join(workspace, "references", "tiles");
}

export async function execute(step: EvidenceStep, ctx: StepContext): Promise<unknown> {
  switch (step) {
    case "fetch":
      return fetchSource(ctx);
    case "probe":
      return probe(ctx);
    case "transcribe":
      return transcribe(ctx);
    case "tiles":
      return tiles(ctx);
  }
}

/** 上传的直接搬进工作目录；链接的交给 hypit 拉（它用的是钉死版本的 yt-dlp） */
async function fetchSource(ctx: StepContext): Promise<unknown> {
  const sourcePath = sourcePathOf(ctx.workspace);
  await mkdir(path.dirname(sourcePath), { recursive: true });

  if (ctx.source.kind === "file") {
    const from = path.resolve(ctx.source.path);

    // 重试 fetch 时 source_path 已经指向工作目录里那一份，from 和目的地是同一个
    // 文件。不先判这一下，下面的「清旧文件」会把用户唯一的源视频删掉，然后报
    // 「上传的文件已经不在了，请重新上传」——而它刚刚被我们自己删了
    if (from === path.resolve(sourcePath)) {
      if (!existsSync(from)) {
        throw new EvidenceError("SOURCE_GONE", "工作目录里的源视频不见了，请重新提交参考视频。", 409);
      }
      return { kind: "file", reused: true };
    }

    assertInsideUploads(from);
    if (!existsSync(from)) {
      throw new EvidenceError("UPLOAD_GONE", "上传的文件已经不在了，请重新上传。", 409);
    }

    // 这里不需要先删目的地：rename 会直接覆盖。url 分支才必须先删——
    // hypit media fetch 拒绝写进已有文件
    try {
      await rename(from, sourcePath);
    } catch (error) {
      // 跨盘 rename 会 EXDEV，退回复制。别的错误（权限等）不该被当成跨盘吞掉
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await copyFile(from, sourcePath);
      await rm(from, { force: true });
    }
    recordSourcePath(ctx.templateId, sourcePath);
    return { kind: "file" };
  }

  await rm(sourcePath, { force: true });

  // 先把钉死版本的 yt-dlp 备好。不备的话第一次贴链接会撞上
  // 「yt-dlp … is not ready; run hypit media prepare-fetch」——那句话对用户
  // 毫无意义，他并不知道 yt-dlp 是什么。装过就是毫秒级返回
  const prepareStarted = Date.now();
  await runHypit<unknown>(["media", "prepare-fetch", "--json"], {
    cwd: ctx.workspace,
    subject: { kind: "template", id: ctx.templateId },
    timeoutMs: STEP_TIMEOUT_MS,
  });

  // 整个 fetch 步共享一份 10 分钟预算（REQ-002：单项 >10 分钟标超时）。
  // 两次 spawn 各给 10 分钟的话，最坏要 20 分钟才标超时
  const left = Math.max(1_000, STEP_TIMEOUT_MS - (Date.now() - prepareStarted));
  const result = await runHypit<unknown>(["media", "fetch", ctx.source.url, "--to", sourcePath, "--json"], {
    cwd: ctx.workspace,
    subject: { kind: "template", id: ctx.templateId },
    timeoutMs: left,
  });
  recordSourcePath(ctx.templateId, sourcePath);
  return result.json;
}

/**
 * 上传文件只能来自上传目录。
 * 不判的话 `uploadPath` 就是一个任意文件搬运接口——传 secrets.json 进来，
 * 它会被 rename 进模板工作目录。后端只绑 127.0.0.1 不是不校验的理由。
 */
function assertInsideUploads(from: string): void {
  const uploads = path.resolve(config.dataRoot, "uploads");
  // 比真实路径：uploads 里放一个指向外面的 junction，字面上照样在目录里。
  // 还得是 uploads 下的一个**文件**：传 uploads 目录本身进来的话，下面的 rename
  // 会把整个目录（连同别人待导入的上传）搬进工作目录当 source.mp4（复审 #2）
  const resolved = path.resolve(from);
  // throwIfNoEntry：exists 与 stat 分两步会有一个删文件的空当，冒出带绝对路径的 ENOENT
  const info = statSync(resolved, { throwIfNoEntry: false });
  const notAFile = info !== undefined && !info.isFile();
  if (resolved === uploads || notAFile || !isReallyInside(uploads, from)) {
    throw new EvidenceError("UPLOAD_OUTSIDE", "上传文件不在上传目录里，拒绝导入。", 400);
  }
}

async function probe(ctx: StepContext): Promise<ProbeFacts> {
  const result = await runHypit<ProbeFacts>(["media", "probe", sourcePathOf(ctx.workspace), "--json"], {
    cwd: ctx.workspace,
    subject: { kind: "template", id: ctx.templateId },
    timeoutMs: STEP_TIMEOUT_MS,
  });

  const verdict = checkProbe(result.json, ctx.maxSeconds);
  if (!verdict.ok) {
    // 先把已经拿到的事实存下来再报错：不存的话界面只能从错误文案里抠时长，
    // 分辨率和帧率就彻底拿不到了
    markDone(ctx.templateId, "probe", result.json);
    throw new EvidenceError(verdict.code, verdict.message, 400);
  }
  return result.json;
}

async function transcribe(ctx: StepContext): Promise<unknown> {
  const to = transcriptPathOf(ctx.workspace);
  await rm(to, { force: true });

  // 服务停着时（重启电脑后必然）transcribe 两秒就失败、只报 fetch failed，
  // 先拉起来。冷启动约 3 分钟，与转写共用这一步的 10 分钟预算
  const started = Date.now();
  const subject = { kind: "template", id: ctx.templateId };
  let readiness: Awaited<ReturnType<typeof ensureWhisperX>>;
  try {
    readiness = await ensureWhisperX(
      ctx.workspace,
      { subject, timeoutMs: STEP_TIMEOUT_MS },
      { onStarting: () => noteRunning(ctx.templateId, "transcribe", "正在启动 WhisperX 服务") },
    );
  } catch (error) {
    // 拉不起来：撤掉「正在启动」再抛。markFailed 会保留已有的 detail，不撤的话失败行上
    // 留着一句「正在启动」，以后读这一行诊断的人会被误导（复审第四轮）
    noteRunning(ctx.templateId, "transcribe", null);
    throw error;
  }
  // 服务起来了，接下来是真的在转写：撤掉「正在启动」，界面回到「转写中」
  if (readiness === "started") noteRunning(ctx.templateId, "transcribe", null);
  const left = Math.max(1_000, STEP_TIMEOUT_MS - (Date.now() - started));

  const result = await runHypit<unknown>(
    [
      "transcribe",
      sourcePathOf(ctx.workspace),
      "--to",
      to,
      "--language",
      ctx.language,
      "--workspace",
      ctx.workspace,
      "--json",
    ],
    { cwd: ctx.workspace, subject, timeoutMs: left },
  );

  const facts = listSteps(ctx.templateId).find((s) => s.step === "probe")?.detail as ProbeFacts | undefined;
  const note = facts ? transcribeNote(facts) : undefined;
  return { ...(result.json as Record<string, unknown>), ...(note ? { note } : {}) };
}

async function tiles(ctx: StepContext): Promise<unknown> {
  const to = tilesDirOf(ctx.workspace);
  // tiles 拒绝写进已有内容，重试前清干净
  await rm(to, { recursive: true, force: true });

  const transcript = transcriptPathOf(ctx.workspace);
  const hasTranscript = existsSync(transcript);
  const result = await runHypit<unknown>(
    [
      "media",
      "tiles",
      sourcePathOf(ctx.workspace),
      "--frames",
      String(TILE_FRAMES),
      // 没有转写结果就不带 --transcript：带了会让 hypit 去读一个不存在的文件
      ...(hasTranscript ? ["--transcript", transcript] : []),
      "--to",
      to,
      "--json",
    ],
    {
      cwd: ctx.workspace,
      subject: { kind: "template", id: ctx.templateId },
      timeoutMs: STEP_TIMEOUT_MS,
    },
  );
  return result.json;
}

function recordSourcePath(templateId: string, sourcePath: string): void {
  db()
    .prepare("UPDATE templates SET source_path = ?, updated_at = ? WHERE id = ?")
    .run(sourcePath, new Date().toISOString(), templateId);
}
