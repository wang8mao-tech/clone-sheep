// Task 5.2 复审实测：被宿主停下的运行，花费还拿不拿得到；Agent 起的子进程有没有被带走。
//
// 单次 query（字符串 prompt）只在最后吐一条 result；AbortController 一掐就没有 result，
// 这次运行的 total_cost_usd 就丢了。这里对比两种停法：
// - 流式输入模式下 query.interrupt()：会不会吐一条带 total_cost_usd 的 result
// - AbortController.abort()：之后工作目录删不删得掉（删不掉 = Bash 起的子进程还活着，
//   删模板时 AC-002「进程已结束再删目录」就不成立）
//
// 全程临时目录，haiku，两次各约 $0.02。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SLEEPER = "node -e \"setTimeout(()=>console.log('done'),60000)\"";
const PROMPT = `用 Bash 在前台运行 \`${SLEEPER}\`（不要放后台），等它输出 done 后只回复 ok。`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function options(cwd, extra = {}) {
  return {
    cwd,
    model: process.env.SPIKE_MODEL ?? "claude-haiku-4-5",
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxBudgetUsd: 0.3,
    env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    ...extra,
  };
}

/** 删不掉说明还有进程以它为工作目录，也就是 Bash 起的子进程没被带走 */
function tryRemove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return "成功";
  } catch (error) {
    return `失败 ${error.code}`;
  }
}

function stamp(log, started, text) {
  if (!text.includes("thinking_tokens")) log.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${text}`);
}

function describe(m) {
  return `${m.type}${m.subtype ? ":" + m.subtype : ""}${m.type === "result" ? ` cost=${m.total_cost_usd}` : ""}`;
}

async function viaInterrupt() {
  const cwd = mkdtempSync(path.join(tmpdir(), "spike-int-"));
  const log = [];
  const started = Date.now();
  let release;
  const held = new Promise((r) => (release = r));
  async function* input() {
    yield { type: "user", message: { role: "user", content: PROMPT }, parent_tool_use_id: null, session_id: "" };
    await held; // 流式模式下关掉输入就等于结束会话，先撑着
  }
  const q = query({ prompt: input(), options: options(cwd) });
  let armed = false;
  try {
    for await (const m of q) {
      stamp(log, started, describe(m));
      if (!armed && m.type === "system" && m.subtype === "task_started") {
        armed = true;
        setTimeout(() => {
          stamp(log, started, "-> interrupt()");
          void q.interrupt();
        }, 3000);
      }
      if (m.type === "result") break;
    }
  } finally {
    release();
    q.close();
  }
  await sleep(1000);
  stamp(log, started, `interrupt + close 后 1 秒删目录：${tryRemove(cwd)}`);
  return log;
}

async function viaAbort() {
  const cwd = mkdtempSync(path.join(tmpdir(), "spike-abort-"));
  const log = [];
  const started = Date.now();
  const controller = new AbortController();
  try {
    for await (const m of query({ prompt: PROMPT, options: options(cwd, { abortController: controller }) })) {
      stamp(log, started, describe(m));
      if (m.type === "system" && m.subtype === "task_started") {
        setTimeout(() => {
          stamp(log, started, "-> abort()");
          controller.abort();
        }, 3000);
      }
    }
  } catch (error) {
    stamp(log, started, `query 抛出：${error instanceof Error ? error.message : String(error)}`);
  }
  await sleep(1000);
  const first = tryRemove(cwd);
  stamp(log, started, `abort 后 1 秒删目录：${first}`);
  if (first !== "成功") {
    await sleep(65_000);
    stamp(log, started, `再等 65 秒（sleeper 自然结束）删目录：${tryRemove(cwd)}`);
  }
  return log;
}

console.log(`== interrupt() ==\n${(await viaInterrupt()).join("\n")}`);
console.log(`== abort() ==\n${(await viaAbort()).join("\n")}`);
