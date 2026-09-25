import { existsSync } from "node:fs";
import path from "node:path";
import { isInside, isReallyInside } from "../lib/safe-path.js";
import { containsPath, resolveFrom, samePath } from "./guard-paths.js";
import { findDeniedHypit, normalize, tokenize } from "./shell-scan.js";
import { writtenPaths } from "./written-paths.js";
import { installsPackages, NODE_MODULES_WHY, writesNodeModules } from "./node-modules-rule.js";

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
  /**
   * Claude Code 自己的凭据文件（`~/.claude/.credentials.json`、CLAUDE_CONFIG_DIR 下的同名文件）：同样不许碰。
   * 第三方模型驱动会话时，读出来的订阅令牌会随下一次请求发给第三方端点（10.2 审查 S2-M2）
   */
  credentialFiles?: readonly string[];
  /** Agent 插件目录（hypit skill 所在）：改了它等于给之后的每次会话下毒 */
  pluginDir?: string;
  /** hypit 启动器目录（PATH 上的 hypit）：同理，改了它等于换掉宿主的 hypit */
  binDir?: string;
  /** hypit-main：可以跑、可以读，不许改 */
  hypitRoot?: string;
  /** 数据根的 node_modules：宿主同步进来的 Provider 包（Codex 生图），改了等于换掉出图的代码 */
  packagesDir?: string;
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
    if (readsCredentialEnv(args.command)) {
      return protectedDenial(
        args.command,
        "模型档案的凭据只注入给 Claude Code 自己用（REQ-010），不许读取凭据变量或导出整份环境变量",
      );
    }
  }

  for (const file of [ctx.secretsFile, ...(ctx.credentialFiles ?? [])]) {
    if (file && readsSecrets(toolName, args, ctx.workspace, file)) {
      return protectedDenial(JSON.stringify(args), "密钥与登录凭据由宿主保管，Agent 不许读取");
    }
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
    if (writesNodeModules(profileRoots(ctx.workspace), resolved)) return protectedDenial(target, NODE_MODULES_WHY);
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
  for (const file of [ctx.secretsFile, ...(ctx.credentialFiles ?? [])]) {
    if (!file) continue;
    const flat = normalize(command).replace(/\\/g, "/").toLowerCase();
    const name = path.basename(file).toLowerCase();
    const stem = name
      .replace(/^\./, "")
      .replace(/\.[^.]*$/, "")
      .slice(0, 6);
    const short = new RegExp(`(^|[\\s"'/=:])${escapeRe(stem)}~\\d`, "i");
    const tokens = tokenize(normalize(command)).map((t) => resolveFrom(ctx.workspace, t));
    if (flat.includes(name) || short.test(flat) || tokens.some((t) => samePath(t, file))) {
      return protectedDenial(command, "密钥与登录凭据由宿主保管，Agent 不许读取或改动");
    }
  }
  if (mentionsClaudeConfigDir(command, ctx.credentialFiles ?? [])) {
    return protectedDenial(command, "Claude Code 的配置目录里有登录凭据，Agent 不许碰");
  }
  const written = writtenPaths(command, ctx.workspace);
  const roots = profileRoots(ctx.workspace);
  if (installsPackages(command) || written.some((p) => writesNodeModules(roots, p))) {
    return protectedDenial(command, NODE_MODULES_WHY);
  }
  for (const [dir, why] of [
    [ctx.pluginDir, "Agent 插件目录由宿主维护，可以读，不许改动"],
    [ctx.binDir, "hypit 启动器目录由宿主维护，不许改动"],
    [ctx.hypitRoot, "hypit-main 可以运行与阅读，不许改动"],
    [ctx.packagesDir, "数据根里的 Provider 包由宿主维护，不许改动"],
  ] as const) {
    if (dir && written.some((p) => isInside(dir, p))) return protectedDenial(command, why);
  }
  const profile = written.find((p) => isProfile(ctx.workspace, p));
  if (profile) return profileDenial(command);
  return undefined;
}

/**
 * 生效的 Runtime Profile 在哪：工作目录自己的，加上 hypit 认的项目根（最近的 package.json 所在目录）的。
 * 变体会话的工作目录是模板目录下的 productions/<id>/，它跑 hypit 时用的是模板目录那份（8.1 审查 MEDIUM-3）
 */
function profileRoots(workspace: string): string[] {
  const roots = [path.resolve(workspace)];
  let dir = path.resolve(workspace);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) {
      if (!roots.includes(dir)) roots.push(dir);
      return roots;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return roots;
    dir = parent;
  }
}

function isProfile(workspace: string, p: string): boolean {
  return profileRoots(workspace).some((root) => PROFILE_FILES.some((f) => samePath(p, path.join(root, f))));
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

/**
 * 读凭据变量或整份导出环境的命令（REQ-010：key 只进 SDK 子进程）。Agent 有完整 Bash，`printenv` 一下
 * 就能把档案的 token 打进消息流、写进工作目录；消息流另有打码兜底（scheduler），这里先拦住。
 * 只拦「整份导出」与「点名凭据变量」：读单个普通变量（`$env:PATH`、`process.env.HOME`）照常放行（10.2 审查 S2-L3）。
 * 没用 Claude Code 的 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB：它会把权限模式强制改回 default（anthropics/claude-code#51258），
 * 无头会话里的每个工具调用都会卡在等人批准
 */
/** 点名凭据变量；`${!ANTHROPIC*}` 这种按前缀列变量名的间接展开也算（数组下标 `${!arr[@]}` 不算） */
const CREDENTIAL_VARS = /\b(ANTHROPIC_(AUTH_TOKEN|API_KEY)|CLAUDE_CODE_OAUTH_TOKEN)\b|\$\{!(?!\w+\[[@*]\]\})/i;
/** 命令位置：行首、分隔符之后、`$(` 里，或跟在 sudo / time / nohup / sh -c / cmd /c（Git Bash 写成 //c）后面 */
const AT_COMMAND = String.raw`(^|[;&|\x60]\s*|\$\(\s*|\b(sudo|time|nohup|command|exec|xargs|builtin)\s+|-c\s+["']?|\bcmd(\.exe)?\s+/{1,2}[ck]\s+["']?)(\S*[\\/])?`;
/** 命令结束：行尾、分隔符、重定向、收尾的引号 / 括号 */
const END = String.raw`\s*($|[;&|)\x60>"'}])`;
/**
 * 整份导出环境：env / printenv 只带选项（-0、-u NAME、--null…）、不跑别的命令也不点名；
 * set / export / export -p / declare -p|-x / typeset -p|-x / compgen -e 不带参数（`set -e` 是设开关，不算）
 */
const ENV_DUMP = new RegExp(
  `${AT_COMMAND}((env|printenv)(\\.exe)?(\\s+(-u\\s+\\S+|-C\\s+\\S+|--?[\\w-]+))*|(set|export(\\s+-p)?|declare\\s+-[px]+|typeset\\s+-[px]+|compgen\\s+-e)(\\.exe)?)${END}`,
  "im",
);
/** cmd 的 `set 前缀` 会列出所有以它开头的变量（`cmd /c set ANTH` 就把 key 列出来了） */
const CMD_SET = /\bcmd(\.exe)?\s+\/{1,2}[ck]\s+["']?\s*set(\s+[^\s=&|"']+)?\s*($|["'|&>])/i;
/** 各语言里整体读环境的写法（点名读单个变量的不算：`$env:PATH`、`env:PATH`、process.env.HOME、os.environ['PATH']） */
const ENV_READ = new RegExp(
  [
    String.raw`\b(Get-ChildItem|Get-Item|gci|gi|dir|ls)\s+(-(Path|LiteralPath)\s+)?["']?env:(?![\w])`,
    String.raw`\b(Set-Location|Push-Location|cd|sl)\s+["']?env:`,
    String.raw`\[(System\.)?Environment\]::GetEnvironmentVariables`,
    String.raw`/proc/[^\s]*/environ`,
    String.raw`\bprocess\s*(\.\s*env\b|\[\s*["']env["']\s*\])(?!\s*[.[])`,
    String.raw`[)\]]\s*\.env\b(?!\s*[.[])`,
    String.raw`\bos\.environ\b(?!\s*(\[|\.get\())`,
    String.raw`\bSystem\.getenv\(\s*\)`,
    String.raw`%ENV\b`,
    String.raw`\bruby\b.*\bENV\b(?!\s*[[=.])`,
  ].join("|"),
  "i",
);

export function readsCredentialEnv(command: string): boolean {
  return CREDENTIAL_VARS.test(command) || ENV_DUMP.test(command) || CMD_SET.test(command) || ENV_READ.test(command);
}

/**
 * 命令里提到了 Claude Code 的配置目录（`~/.claude`、`$HOME/.claude`、CLAUDE_CONFIG_DIR 那一处）：不点凭据文件名、
 * 用通配（`.cred*`）或整目录操作（`grep -r … ~/.claude`、`cp -r ~/.claude`）同样能读到登录凭据（10.2 第二轮审查 S2-L1）
 */
const HOME_CLAUDE =
  /(^|[\s"'=:(])(~|\$home|\$\{home\}|%userprofile%|\$env:userprofile|[a-z]:\/users\/[^/\s"']+)\/\.claude(\/|[\s"')]|$)/i;

function mentionsClaudeConfigDir(command: string, credentialFiles: readonly string[]): boolean {
  const flat = normalize(command).replace(/\\/g, "/").toLowerCase();
  if (HOME_CLAUDE.test(flat)) return true;
  return credentialFiles
    .map((file) => path.dirname(file).replace(/\\/g, "/").toLowerCase())
    .some((dir) => flat.includes(dir));
}
