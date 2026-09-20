// Phase 0 验证二补测：canUseTool 在 streaming input 模式下是否会被调用。
// 背景：spike-agent.mjs 的 A/B/C/E/F 五组都用 string prompt，canUseTool 一次都没被调用过，
// 包括关掉 sandbox.autoAllowBashIfSandboxed 之后。这里换成 AsyncIterable prompt 再验一次。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.SPIKE_MODEL ?? "claude-haiku-4-5";
const BASH_PROMPT = "请用 Bash 工具运行 `echo hello-from-spike`，然后用一句话告诉我结果。";
const workdir = mkdtempSync(join(tmpdir(), "spike-agent-stream-"));
const report = { model: MODEL, workdir, canUseToolCalls: [], messageTypes: [] };

async function* streamingPrompt() {
  yield {
    type: "user",
    message: { role: "user", content: BASH_PROMPT },
    parent_tool_use_id: null,
    session_id: "",
  };
}

try {
  const q = query({
    prompt: streamingPrompt(),
    options: {
      model: MODEL,
      cwd: workdir,
      maxTurns: 6,
      settingSources: [],
      permissionMode: "default",
      canUseTool: async (toolName, input) => {
        report.canUseToolCalls.push({ toolName, input });
        if (toolName === "Bash") return { behavior: "deny", message: "spike: Bash 被策略拒绝" };
        return { behavior: "allow", updatedInput: input };
      },
    },
  });

  for await (const message of q) {
    report.messageTypes.push(message.subtype ? `${message.type}:${message.subtype}` : message.type);
    if (message.type === "result") {
      report.result = {
        subtype: message.subtype,
        is_error: message.is_error,
        num_turns: message.num_turns,
        total_cost_usd: message.total_cost_usd,
        permission_denials: message.permission_denials,
        text: typeof message.result === "string" ? message.result.slice(0, 200) : undefined,
      };
      break; // streaming input 模式不会自己结束，拿到结果就收
    }
  }
} catch (error) {
  report.error = { name: error?.name, message: error?.message };
} finally {
  rmSync(workdir, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
