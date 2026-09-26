// Task 5.2 开工实测：Bash 跑一条长命令时，SDK 在无头模式下会不会持续吐消息。
// Spec 的卡死熔断是「10 分钟无任何新消息」；如果长命令期间一条消息都没有，
// 跑 12 分钟的 hypit transcribe 会被误判卡死。这里让 Agent 前台跑一条 45 秒的 node 命令（Claude Code 会直接拦下裸 `sleep 45`），记录每条消息的类型与时间。
//
// 全程临时目录，haiku，约 $0.02。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "spike-progress-"));
const started = Date.now();
const seen = [];
try {
  for await (const m of query({
    prompt:
      "用 Bash 在前台运行 `node -e \"setTimeout(()=>console.log('done'),45000)\"`（不要放后台），等它输出 done 后只回复 ok。",
    options: {
      cwd: root,
      model: process.env.SPIKE_MODEL ?? "claude-haiku-4-5",
      settingSources: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxBudgetUsd: 0.2,
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    },
  })) {
    const t = ((Date.now() - started) / 1000).toFixed(1);
    const label = m.type === "system" || m.type === "result" ? `${m.type}:${m.subtype}` : m.type;
    let extra = m.type === "tool_progress" ? ` elapsed=${m.elapsed_time_seconds} heartbeat=${m.heartbeat}` : "";
    if (m.type === "assistant" || m.type === "user") {
      const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
      extra =
        " " +
        blocks
          .map((b) =>
            b.type === "tool_use"
              ? `tool_use(${b.name} ${JSON.stringify(b.input).slice(0, 160)})`
              : b.type === "tool_result"
                ? `tool_result(err=${b.is_error} ${JSON.stringify(b.content).slice(0, 200)})`
                : b.type === "text"
                  ? `text(${b.text.slice(0, 80)})`
                  : b.type,
          )
          .join(" | ");
    }
    seen.push(`${t}s ${label}${extra}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(seen.join("\n"));
