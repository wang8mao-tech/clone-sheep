import path from "node:path";
import { isInside, isReallyInside } from "../lib/safe-path.js";
import { containsPath, resolveFrom, samePath } from "./guard-paths.js";
import { findDeniedHypit, normalize, tokenize } from "./shell-scan.js";
import { writtenPaths } from "./written-paths.js";

export { findDeniedHypit } from "./shell-scan.js";

/**
 * Agent 工具调用的硬拦截规则（Spec REQ-003，v1.9）。
 *
 * 由 PreToolUse hook 调用：hook 先于 SDK 的一切权限检查执行，bypassPermissions 下照样
 * 生效，子 Agent 里的调用也经过它（2026-09-22 实测，scripts/spike-hook.mjs）。这里只做
 * 纯判断，不碰 SDK，方便把每一种写法钉进单测。
 *
 * 目标：
 * 1. 花钱或改宿主状态的 hypit 命令（shell-scan.ts，威胁模型写在那边）。
 * 2. 文件写工具写到工作目录之外。
 * 3. 宿主的敏感位置：密钥文件不许读；Agent 插件目录、hypit 启动器目录、hypit-main 可读不可写；
 *    工作目录里的 Runtime Profile（hypit.runtime.json、.hypit/runtime）由宿主生成，不许改——
 *    改了就能把宿主之后的 build 路由到别的端点或凭据源。
 * 4. 全局安装软件包（hypit skill 会建议 `npm install --global @hypit/hypit`；宿主已把 hypit 放上 PATH）。
 *
 * 专用读工具（Read / Grep / Glob）按真实路径保护密钥文件，8.3 短名、NTFS 数据流、
 * 祖先目录搜索都算。Bash 里只拦字面提到密钥文件的写法，写路径只解析常见写法（重定向、
 * 改文件的命令、cd 之后的相对路径）。同一 Windows 用户下拦不死，v1 接受（Spec REQ-003
 * 「拦截的边界」）；花钱的兜底是 Agent 环境里没有 key。
 */

export interface Denial {
  /** 给模型看的拒绝原因：说清是宿主策略，免得它换写法重试 */
  reason: string;
  /** 给宿主日志用的规则名 */
  rule: "hypit-command" | "write-outside-workspace" | "protected-path";
  /** 命中的命令或路径原文 */
  detail: string;
}

export interface GuardContext {
  workspace: string;
  /** 宿主密钥文件：不许读、不许在命令里出现 */
  secretsFile?: string;
  /** Agent 插件目录（hypit skill 所在）：改了它等于给之后的每次会话下毒 */
  pluginDir?: string;
  /** hypit 启动器目录（PATH 上的 hypit）：同理，改了它等于换掉宿主的 hypit */
  binDir?: string;
  /** hypit-main：可以跑、可以读，不许改 */
  hypitRoot?: string;
}

/** 工作目录里宿主生成的 Runtime Profile 与它的选择文件 */
const PROFILE_FILES = ["hypit.runtime.json", path.join(".hypit", "runtime")];

const GLOBAL_INSTALL =
  /\b(npm|pnpm|yarn|bun)\b(?=[^;&|\n]*\b(i|install|add)\b)(?=[^;&|\n]*\s(-g|--global|--location[= ]global)\b)|\byarn\s+global\s+add\b/i;

export function judgeToolCall(toolName: string, input: unknown, ctx: GuardContext): Denial | undefined {
  const args = isRecord(input) ? input : {};

  // 任何带 command 字段的工具都当 shell 看：Bash、Windows 上的 PowerShell 工具都是这个形状
  if (typeof args.command === "string") {
    const hit = findDeniedHypit(args.command);
    if (hit) {
      return {
        rule: "hypit-command",
        detail: args.command,
        reason:
          `已拦截：出片与结果管理由宿主负责，Agent 不允许执行 \`hypit ${hit}\`。` +
          "请把 SVML 写到 hypit check 通过为止，出片交给宿主。不要换写法重试。",
      };
    }
    if (GLOBAL_INSTALL.test(args.command)) {
      return protectedDenial(args.command, "不许全局安装软件包；hypit 已经在 PATH 上，直接运行 `hypit`");
    }
    const touched = protectedInCommand(args.command, ctx);
    if (touched) return touched;
  }

  if (ctx.secretsFile && readsSecrets(toolName, args, ctx.workspace, ctx.secretsFile)) {
    return protectedDenial(JSON.stringify(args), "密钥文件由宿主保管，Agent 不许读取");
  }

  const target = writeTarget(toolName, args);
  if (target !== undefined) {
    const resolved = resolveFrom(ctx.workspace, target);
    if (!isReallyInside(ctx.workspace, resolved)) {
      return {
        rule: "write-outside-workspace",
        detail: target,
        reason: `已拦截：只能写工作目录之内的文件（${ctx.workspace}），不允许写 ${target}。`,
      };
    }
    if (isProfile(ctx.workspace, resolved)) return profileDenial(target);
  }
  return undefined;
}

/** 文件写工具的目标路径。Edit(path) 规则在 SDK 里同管 Write / NotebookEdit，这里对齐 */
function writeTarget(toolName: string, args: Record<string, unknown>): string | undefined {
  if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) return undefined;
  const p = args.file_path ?? args.notebook_path;
  return typeof p === "string" && p.trim() ? p : undefined;
}

/**
 * 专用读工具碰到密钥文件：Read 读它本身；Grep / Glob 的搜索根是它或它的祖先目录
 * （`Grep path: ../../..` 会把它扫进来），Glob 模式的固定前缀同理；模式里带 `..` 的
 * 一律不许（`{../../x,*.md}`、`**\/../..` 这类前缀算不准）。
 */
function readsSecrets(toolName: string, args: Record<string, unknown>, workspace: string, secrets: string): boolean {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  if (toolName === "Read") {
    const p = str(args.file_path);
    return p !== undefined && samePath(resolveFrom(workspace, p), secrets);
  }
  if (toolName !== "Grep" && toolName !== "Glob") return false;
  const root = resolveFrom(workspace, str(args.path) ?? ".");
  const roots = [root];
  const pattern = toolName === "Glob" ? str(args.pattern) : str(args.glob);
  if (pattern) {
    if (/(^|[\\/{,])\.\.([\\/},]|$)/.test(pattern)) return true;
    roots.push(resolveFrom(root, staticPrefix(pattern)));
  }
  return roots.some((r) => samePath(r, secrets) || containsPath(r, secrets));
}

/** 通配模式里第一个通配符之前的目录部分：`C:/data/*.json` → `C:/data` */
function staticPrefix(pattern: string): string {
  const cut = pattern.search(/[*?[{]/);
  return cut < 0 ? pattern : path.dirname(`${pattern.slice(0, cut)}x`);
}

/**
 * 命令里碰了宿主敏感位置：提到密钥文件就拦；插件目录、启动器目录、hypit-main、
 * Runtime Profile 只在被写时拦——Agent 要运行 hypit、读 skill 的 references、把示例复制出来。
 */
function protectedInCommand(command: string, ctx: GuardContext): Denial | undefined {
  if (ctx.secretsFile) {
    const flat = normalize(command).replace(/\\/g, "/").toLowerCase();
    const name = path.basename(ctx.secretsFile).toLowerCase();
    const stem = name.replace(/\.[^.]*$/, "").slice(0, 6);
    const short = new RegExp(`(^|[\\s"'/=:])${escapeRe(stem)}~\\d`, "i");
    const tokens = tokenize(normalize(command)).map((t) => resolveFrom(ctx.workspace, t));
    if (flat.includes(name) || short.test(flat) || tokens.some((t) => samePath(t, ctx.secretsFile as string))) {
      return protectedDenial(command, "密钥文件由宿主保管，Agent 不许读取或改动");
    }
  }
  const written = writtenPaths(command, ctx.workspace);
  for (const [dir, why] of [
    [ctx.pluginDir, "Agent 插件目录由宿主维护，可以读，不许改动"],
    [ctx.binDir, "hypit 启动器目录由宿主维护，不许改动"],
    [ctx.hypitRoot, "hypit-main 可以运行与阅读，不许改动"],
  ] as const) {
    if (dir && written.some((p) => isInside(dir, p))) return protectedDenial(command, why);
  }
  const profile = written.find((p) => isProfile(ctx.workspace, p));
  if (profile) return profileDenial(command);
  return undefined;
}

function isProfile(workspace: string, p: string): boolean {
  return PROFILE_FILES.some((f) => samePath(p, path.join(workspace, f)));
}

function profileDenial(detail: string): Denial {
  return protectedDenial(
    detail,
    "Runtime Profile（hypit.runtime.json、.hypit/runtime）由宿主生成，Agent 不许改动；缺能力就在产物里写明缺什么",
  );
}

function protectedDenial(detail: string, why: string): Denial {
  return { rule: "protected-path", detail, reason: `已拦截：${why}。不要换写法重试。` };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
