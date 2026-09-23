import { readFileSync } from "node:fs";
import path from "node:path";
import { HYPIT_SKILL } from "./plugin.js";

/**
 * Agent 的系统提示追加段与任务提示（Spec REQ-003、REQ-004、REQ-005）。
 *
 * 系统提示用 Claude Code 预设 + append：保留它的全部工具说明与工作习惯，只把宿主规则
 * 接在后面。宿主规则写的是「为什么」而不是一串禁令——拦截由 PreToolUse hook 硬执行，
 * 这里的作用是让模型一开始就不去碰，而不是等被拒了再绕。
 */

export interface HostContext {
  workspace: string;
}

export function hostSystemAppend(ctx: HostContext): string {
  return [
    "## 你所在的环境：Clone Studio 宿主里的无头会话",
    "",
    `- 工作目录是 ${ctx.workspace}。所有产物都写在这里；工作目录之外的路径（包括 hypit-main 与任何系统目录）宿主会直接拒绝写入。`,
    "- `hypit` 已经在 PATH 上，直接运行 `hypit <命令>`，不要去找 hypit-main 的路径，也不要安装 hypit。",
    `- 写 SVML / SVS / SVRun 时先调用 \`${HYPIT_SKILL}\` 这个 skill，按它的规范写。`,
    "- **出片由宿主负责。** 你的任务终点是 `hypit check <source> --json` 通过为止。`hypit build`、`hypit result`、`hypit cancel`、改 Runtime Profile 或凭据的命令都由宿主在人确认花费后执行，你运行会被拒绝——被拒绝时不要换写法重试，把稿子写到 check 通过即可。",
    "- 没有人实时看着你：不要提问、不要等待确认，拿不准的地方按最合理的判断做，并把判断写进产物里说明。",
    "- 不要跑不会自己结束的命令：`hypit studio`、带 `--watch` 的 `status` / `activity`。宿主会把长时间没有新消息的会话判为卡死并停掉。",
    "",
    capabilitySection(ctx.workspace),
  ].join("\n");
}

/**
 * 当前工作目录能解析的生成能力（Spec：MUST 把可用能力清单写进系统提示，只用可用能力写 SVML）。
 * 取自 hypit.runtime.json 的 bindings：它就是 hypit 出片时实际能找到 Provider 的那张表，
 * 不另编一份，免得提示里说有、plan 时却没有。
 */
export function capabilitySection(workspace: string): string {
  const bindings = readBindings(workspace);
  if (!bindings) {
    return "## 可用生成能力\n\n读不到工作目录的 hypit.runtime.json，先用 `hypit plan` 看哪些请求能解析，再动笔。";
  }
  const lines = Object.entries(bindings)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([capability, endpoint]) => `- ${capability} → ${endpoint}`);
  return [
    "## 可用生成能力（本工作目录的 Runtime Profile）",
    "",
    "只用下面这些能力写 SVML。需要清单之外的能力（例如这里没有生图 / 生视频 / TTS 端点）时，",
    "不要硬写：在产物里明确标出缺哪种能力，`hypit plan` 出现无 Provider 可解析的请求就当作失败原因报告。",
    "",
    ...lines,
  ].join("\n");
}

function readBindings(workspace: string): Record<string, string> | undefined {
  try {
    const profile = JSON.parse(readFileSync(path.join(workspace, "hypit.runtime.json"), "utf8")) as {
      bindings?: Record<string, unknown>;
    };
    const entries = Object.entries(profile.bindings ?? {}).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    );
    return Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

export interface ClonePromptInput {
  language: string;
  note?: string;
}

/**
 * 复刻任务（REQ-004）。完成判据与 Phase 6 对齐：reference.svrun 存在且 check 通过，
 * ANALYSIS.md、TIMELINE.md 存在。证据文件的位置是 Phase 4 证据流水线定下的。
 */
export function clonePrompt(input: ClonePromptInput): string {
  return [
    "复刻工作目录里的参考视频，写成可复用的 Hypit 模板。",
    "",
    "证据（证据准备阶段已经生成，直接用）：",
    "- 参考视频：references/src/source.mp4",
    `- 逐词转写：references/transcript.json（语言 ${input.language}，词级时间戳）`,
    "- 抽帧拼图：references/tiles/*.jpg",
    "",
    "要交付的文件：",
    "1. ANALYSIS.md —— 结构、节奏、画面语言、文字与声音的分析；最后一节「不确定项」列出你拿不准、需要人验货时特别看的地方。",
    "2. TIMELINE.md —— 带时间码的逐段时间线（mm:ss.s 起止 + 这一段画面与声音在做什么）。",
    "3. reference.svml / reference.svs / reference.svrun —— 按参考视频原样复刻的源文件。",
    "",
    "完成标准：`hypit check reference.svrun --json` 通过。通过后停下，不要出片。",
    ...(input.note ? ["", "用户的复刻备注（优先照此取舍）：", input.note] : []),
  ].join("\n");
}

/** 验货打回（REQ-004 FLOW-002）：作为新消息 resume 原会话，所以只写这一轮要改什么 */
export function rejectPrompt(feedback: string, round: number): string {
  return [
    `验货打回意见 #${round}：`,
    feedback,
    "",
    "按意见修改复刻源文件，同步更新 ANALYSIS.md / TIMELINE.md 里受影响的部分，",
    "改到 `hypit check reference.svrun --json` 通过为止。不要出片。",
  ].join("\n");
}

/**
 * 继续（resume 同一会话）：熔断、中断、等待额度后续跑都用它。会话里原任务还在，
 * 这里只提醒从已有产物接着做，别从头重写把已花的钱白花。
 */
export function continuePrompt(): string {
  return [
    "继续完成之前的任务：从上次停下的地方接着做，完成标准不变。",
    "先看工作目录里已经写好的产物，在它们基础上补完，不要从头重写。不要出片。",
  ].join("\n");
}

/**
 * 复刻判据没过之后的「继续」：会话以为自己做完了，宿主要把没过的原因说给它听，
 * 否则 resume 一次大概率原样停下，白花一次钱（Task 6.1 审查 S2-M3）。
 */
export function cloneRetryPrompt(reason: string): string {
  return [
    `宿主核对完成判据没有通过：${reason}`,
    "在工作目录已有产物的基础上补齐，以 `hypit check reference.svrun --json` 通过为准，通过后停下，不要出片。",
  ].join("\n");
}

export interface VariantPromptInput {
  brief: string;
  templateSource: string;
}

/** 写变体（REQ-005）。Phase 8 接上批量与素材审核前，这里先定下提示的骨架 */
export function variantPrompt(input: VariantPromptInput): string {
  return [
    `以模板 ${input.templateSource} 为基础，按下面的 brief 写一条新的变体。`,
    "",
    "Brief：",
    input.brief,
    "",
    "保留模板的结构与节奏，替换内容；用到的素材在 SOURCES.json 里逐条写明来源，找不到可用素材的在里面标注缺口。",
    "完成标准：变体的 .svrun `hypit check --json` 通过。通过后停下，不要出片。",
  ].join("\n");
}
