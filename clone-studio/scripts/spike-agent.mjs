// Phase 0 验证二：Claude Agent SDK 在订阅登录下的三项事实（解 ASM-002）
//   1. 结果消息的 total_cost_usd 是否有可用数值 → $5 熔断能否成立
//   2. 怎样才能真的拦下一条 Bash → canUseTool 在什么条件下会被调用
//   3. resume 能否续上同一会话
// 不依赖 ANTHROPIC_API_KEY，走本机 Claude Code 的订阅登录凭据。
//
// 三组对照：
//   A 继承本机设置（不传 settingSources）
//   B SDK 隔离 + permissionMode 'default'
//   C SDK 隔离 + disallowedTools: ["Bash"]
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.SPIKE_MODEL ?? "claude-haiku-4-5";
const BASH_PROMPT = "请用 Bash 工具运行 `echo hello-from-spike`，然后用一句话告诉我结果。";
const workdir = mkdtempSync(join(tmpdir(), "spike-agent-"));
const report = { model: MODEL, workdir, sdkVersion: null, runs: [] };

async function runOnce(label, prompt, extraOptions = {}) {
  const messageTypes = [];
  const canUseToolCalls = [];
  const run = { label, options: Object.keys(extraOptions), messageTypes, canUseToolCalls };

  const options = {
    model: MODEL,
    cwd: workdir,
    maxTurns: Number(process.env.SPIKE_MAX_TURNS ?? 6),
    canUseTool: async (toolName, input) => {
      canUseToolCalls.push({ toolName, input });
      if (toolName === "Bash") return { behavior: "deny", message: "spike: Bash 被策略拒绝" };
      return { behavior: "allow", updatedInput: input };
    },
    ...extraOptions,
  };

  try {
    for await (const message of query({ prompt, options })) {
      messageTypes.push(message.subtype ? `${message.type}:${message.subtype}` : message.type);
      if (message.type === "system" && message.subtype === "init") run.sessionId = message.session_id;
      if (message.type === "result") {
        run.result = {
          subtype: message.subtype,
          is_error: message.is_error,
          num_turns: message.num_turns,
          total_cost_usd: message.total_cost_usd,
          total_cost_usd_type: typeof message.total_cost_usd,
          modelUsageKeys: Object.keys(message.modelUsage ?? {}),
          permission_denials: message.permission_denials,
          text: typeof message.result === "string" ? message.result.slice(0, 160) : undefined,
        };
      }
    }
  } catch (error) {
    run.threw = { name: error?.name, message: error?.message };
  }
  report.runs.push(run);
  return run;
}

const GROUPS = (process.env.SPIKE_GROUPS ?? "A,B,C,D").split(",");
try {
  if (GROUPS.includes("A"))
    // A 组：不传 settingSources，继承 ~/.claude 的 permissions 与 hooks
    await runOnce("A-inherit-settings", BASH_PROMPT);

  if (GROUPS.includes("B"))
    await runOnce("B-isolated-default-mode", BASH_PROMPT, {
      settingSources: [],
      permissionMode: "default",
    });

  // C 组：SDK 隔离 + 规则层直接禁用 Bash（B 组证明 canUseTool 不会被调用）
  const c = GROUPS.includes("C")
    ? await runOnce("C-isolated-disallow-bash", BASH_PROMPT, {
        settingSources: [],
        permissionMode: "default",
        disallowedTools: ["Bash"],
      })
    : {};

  // E 组：C 组实测发现模型会派 Task 子 Agent 绕开 Bash 限制，这里把 Task 一并禁掉
  if (GROUPS.includes("E"))
    await runOnce("E-isolated-disallow-bash-and-task", BASH_PROMPT, {
      settingSources: [],
      permissionMode: "default",
      disallowedTools: ["Bash", "Task"],
    });

  // F 组：关掉沙箱自动放行，看 canUseTool 是否终于被调用
  //（REQ-003 的 AC-007 要拦的是 Bash 里的特定命令，不是整个 Bash 工具，只能靠 canUseTool）
  if (GROUPS.includes("F"))
    await runOnce("F-sandbox-no-auto-allow", BASH_PROMPT, {
      settingSources: [],
      permissionMode: "default",
      sandbox: { enabled: true, autoAllowBashIfSandboxed: false, failIfUnavailable: false },
    });

  // resume：续 C 组会话，确认上下文接得上
  if (c.sessionId && GROUPS.includes("D")) {
    await runOnce("D-resume-of-C", "用一句话复述：我上一条消息让你运行的命令是什么？", {
      settingSources: [],
      permissionMode: "default",
      disallowedTools: ["Bash"],
      resume: c.sessionId,
    });
  } else {
    report.resumeSkipped = "C 组没有拿到 session_id";
  }
} catch (error) {
  report.error = { name: error?.name, message: error?.message, stack: error?.stack?.split("\n").slice(0, 5) };
} finally {
  rmSync(workdir, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
