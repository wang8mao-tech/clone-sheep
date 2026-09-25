import { homedir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { judgeToolCall, type Denial, type GuardContext } from "./guard.js";
import { HYPIT_SKILL } from "./plugin.js";
import { hostSystemAppend } from "./prompts.js";

/**
 * Agent 会话配置（Spec REQ-003，v1.9）。每一条都有实测出处，改之前先看注释。
 */

/** 子 Agent 工具：现名 Agent，旧名 Task。两个都禁，作 hook 之外的第二道 */
export const SUBAGENT_TOOLS = ["Agent", "Task"] as const;

export interface SessionInput {
  workspace: string;
  pluginDir: string;
  /** hypit 启动器目录（hypit-bin.ts）：放到 Agent 的 PATH 最前面 */
  binDir?: string;
  /** 宿主的敏感位置，交给 guard：密钥文件、hypit-main */
  secretsFile?: string;
  hypitRoot?: string;
  /** 不给就用 Claude Code 订阅的默认模型 */
  model?: string;
  /** 这次会话用的模型档案（REQ-010）：要注入的变量、是不是订阅、有没有原生联网搜索 */
  profile?: SessionProfile;
  /** 吐流式事件（按单价折算花费时要看运行中的输出 token，price-meter.ts） */
  includePartialMessages?: boolean;
  /** 花费熔断（美元），走 SDK 原生 maxBudgetUsd + error_max_budget_usd，不自己累加 */
  maxBudgetUsd: number;
  /** 续上已有会话（继续 / 打回） */
  resume?: string;
  abortController?: AbortController;
  /** 由宿主自己 spawn Claude Code 进程，登记进 procs（runner.ts） */
  spawnClaudeCodeProcess?: Options["spawnClaudeCodeProcess"];
  /** 每拦下一次调用一次：宿主自己的拦截日志（不读 SDK 的 permission_denials） */
  onIntercept: (denial: Denial & { tool: string; agentId?: string }) => void;
}

/**
 * 挂在 PreToolUse 上的拦截 hook：不带 matcher，所有工具调用都过一遍。
 *
 * **出任何异常一律拒绝（fail closed）**：SDK 对 hook 抛异常的处理是照常执行工具（复审
 * 实测），而 guard 里的路径解析、onIntercept 里将来的落库都可能抛——恰好在有人试图
 * build 的那一刻把「拒绝」变成「放行」。拦截日志另包一层：记不下来不影响拒绝。
 */
export function guardHook(ctx: GuardContext, onIntercept: SessionInput["onIntercept"]): HookCallback {
  const deny = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  });
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    let denial: Denial | undefined;
    try {
      denial = judgeToolCall(input.tool_name, input.tool_input, ctx);
    } catch (error) {
      denial = {
        rule: "protected-path",
        detail: String(input.tool_name),
        reason: `已拦截：宿主无法判断这次调用是否安全（${error instanceof Error ? error.message : String(error)}）。这不是出片策略的拒绝，可以拆成更简单的命令再试。`,
      };
    }
    if (!denial) return {};
    try {
      onIntercept({ ...denial, tool: input.tool_name, ...(input.agent_id ? { agentId: input.agent_id } : {}) });
    } catch {
      // 日志记不下来也必须拒绝；日志丢一条比放过一次 build 强
    }
    return deny(denial.reason);
  };
}

/**
 * Agent 进程能继承的环境变量：只放行跑命令必需的系统变量，其余一律不带（Spec §8：key 不进
 * Agent 环境）。用放行名单而不是剔除名单：用户的 shell 里常年挂着各家 key（复审实测本机有
 * ELEVENLABS_API_KEY、FISH_API_KEY），剔除名单永远列不全；Agent 有完整 Bash 与联网能力，
 * 拿到任何一家的 key 都能绕开 hypit 直接花钱。
 */
const ENV_ALLOW = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "PUBLIC",
  "ALLUSERSPROFILE",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PSMODULEPATH",
  "SHELL",
  "TERM",
  "LANG",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  // Claude Code 自己要的：Windows 上 Bash 工具找 Git Bash、配置目录、订阅登录令牌
  "CLAUDE_CODE_GIT_BASH_PATH",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // hypit 的状态根（runtime-host-node 的 hypitHostStateRoot）：宿主设了它，Agent 的 hypit 必须看同一处，
  // 否则 Agent 查到的 builds / status 与宿主对不上
  "HYPIT_STATE_HOME",
]);
/** HYPIT_* 不整体放行：hypit 生产代码只读 HYPIT_STATE_HOME（已单列），整体放行会混进名字不像凭据的 key */
const ENV_ALLOW_PREFIX = /^LC_/;
/** 放行前缀里也可能混进凭据：命中这些字样一律不带 */
const LOOKS_SECRET = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/**
 * Agent 进程的环境。
 * - 只带放行名单里的变量（见上）：生成服务 key、ANTHROPIC_API_KEY（留着会让会话悄悄走 API
 *   计费而不是订阅；换档案时由档案显式注入，REQ-010）、别的工具的令牌都进不来。
 * - PATH 最前面放 hypit 启动器：Agent 直接敲 `hypit`，不用找路径、不用全局安装。
 * - NODE_OPTIONS 清空：带进子进程会让 hypit 加载不相干的 loader。
 */
export function agentEnv(parent: NodeJS.ProcessEnv = process.env, binDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const allowed = ENV_ALLOW.has(upper) || (ENV_ALLOW_PREFIX.test(upper) && !LOOKS_SECRET.test(upper));
    if (allowed) env[name] = value;
  }
  env.NODE_OPTIONS = "";
  if (binDir) {
    // Windows 上变量名是 Path，大小写不敏感：沿用已有的那个名字，别造出第二个 PATH
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[key] = env[key] ? `${binDir}${path.delimiter}${env[key]}` : binDir;
  }
  return env;
}

/** Claude Code 的登录凭据文件（默认在 ~/.claude，CLAUDE_CONFIG_DIR 可以改位置）：交给 guard 保护 */
export function claudeCredentialFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [path.join(homedir(), ".claude"), ...(env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : [])];
  return dirs.map((dir) => path.join(dir, ".credentials.json"));
}

/**
 * 宿主要保护的全部本机登录凭据：Claude Code 的，加上 Codex 的 `$CODEX_HOME/auth.json`（默认 ~/.codex）——
 * Codex 生图接进来之后它是产品依赖的 ChatGPT 订阅凭据，第三方模型驱动的会话读到它就会发给第三方（11.2 审查 M4）
 */
export function hostCredentialFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const codexHome = env.CODEX_HOME?.trim() ? path.resolve(env.CODEX_HOME.trim()) : path.join(homedir(), ".codex");
  return [...claudeCredentialFiles(env), path.join(codexHome, "auth.json")];
}

export interface SessionProfile {
  env: Record<string, string>;
  subscription: boolean;
  webSearch: boolean;
}

/**
 * 会话环境 = 放行名单里的系统变量 + 档案注入的变量。非订阅档案去掉本机订阅令牌：
 * 否则 Claude Code 可能把订阅凭据发到第三方端点（REQ-010）。只在这次会话的 env 里改，不碰 process.env
 */
export function sessionEnv(base: Record<string, string>, profile?: SessionProfile): Record<string, string> {
  if (!profile) return base;
  const env = { ...base };
  if (!profile.subscription) {
    for (const name of Object.keys(env)) if (name.toUpperCase() === "CLAUDE_CODE_OAUTH_TOKEN") delete env[name];
  }
  return { ...env, ...profile.env };
}

export function buildSessionOptions(input: SessionInput): Options {
  // 没有原生联网搜索的档案（第三方端点）：WebSearch 是 Anthropic 服务端工具，调了只会报错，直接不给（REQ-010）
  const webSearch = input.profile?.webSearch ?? true;
  const options: Options = {
    cwd: input.workspace,
    // 不继承用户 ~/.claude 的权限规则与 hooks：Phase 0 实测不传时消息流里出现 system:hook_started
    settingSources: [],
    // hypit skill 走插件加载：settingSources: [] 下 .claude/skills 不会被读（实测）
    plugins: [{ type: "local", path: input.pluginDir }],
    // 只放行 hypit 这一个 skill，Claude Code 自带的 dataviz / code-review 之类不给，免得带偏
    skills: [HYPIT_SKILL],
    // 完整能力直接可用（无头下没人点批准）；拦截全靠 hook——hook 在 bypass 下照样生效（实测）
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: [...SUBAGENT_TOOLS, ...(webSearch ? [] : ["WebSearch"])],
    hooks: {
      PreToolUse: [
        {
          hooks: [
            guardHook(
              {
                workspace: input.workspace,
                pluginDir: input.pluginDir,
                ...(input.binDir ? { binDir: input.binDir } : {}),
                ...(input.secretsFile ? { secretsFile: input.secretsFile } : {}),
                credentialFiles: hostCredentialFiles(),
                ...(input.hypitRoot ? { hypitRoot: input.hypitRoot } : {}),
                packagesDir: path.join(config.dataRoot, "node_modules"),
              },
              input.onIntercept,
            ),
          ],
        },
      ],
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: hostSystemAppend({ workspace: input.workspace, webSearch }),
    },
    maxBudgetUsd: input.maxBudgetUsd,
    ...(input.includePartialMessages ? { includePartialMessages: true } : {}),
    env: sessionEnv(agentEnv(process.env, input.binDir), input.profile),
    ...(input.model ? { model: input.model } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.abortController ? { abortController: input.abortController } : {}),
    ...(input.spawnClaudeCodeProcess ? { spawnClaudeCodeProcess: input.spawnClaudeCodeProcess } : {}),
  };
  assertSessionOptions(options);
  return options;
}

/**
 * 会话配置的硬约束。任何一条不满足就不许启动——这些不是风格问题，缺了就是花钱动作
 * 拦不住或行为不可复现（DEV-PLAN Phase 5 验收：「只禁 Bash」的配置必须判为不合法）。
 */
export function assertSessionOptions(options: Options): void {
  const problems: string[] = [];
  if (!Array.isArray(options.settingSources) || options.settingSources.length > 0) {
    problems.push("settingSources 必须是 []：否则会继承用户本机 ~/.claude 的权限规则与 hooks");
  }
  const denied = new Set(options.disallowedTools ?? []);
  for (const tool of SUBAGENT_TOOLS) {
    if (!denied.has(tool)) problems.push(`disallowedTools 必须含 ${tool}：否则模型会派子 Agent 绕开`);
  }
  if (denied.has("Bash")) {
    problems.push("disallowedTools 不能禁 Bash：会拿走 Agent 的完整能力；拦截 build 靠 PreToolUse hook");
  }
  const preToolUse = options.hooks?.PreToolUse ?? [];
  if (!preToolUse.some((m) => !m.matcher && m.hooks.length > 0)) {
    problems.push("必须挂一个不带 matcher 的 PreToolUse 拦截 hook：它是花钱动作的主拦截");
  }
  if (typeof options.maxBudgetUsd !== "number" || !(options.maxBudgetUsd > 0)) {
    problems.push("maxBudgetUsd 必须是正数：花费熔断走 SDK 原生机制");
  }
  if (problems.length > 0) throw new Error(`Agent 会话配置不合法：\n- ${problems.join("\n- ")}`);
}
