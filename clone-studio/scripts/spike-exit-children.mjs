// Task 5.2 复审第四轮实测：会话正常结束时，Agent 起的后台命令会不会跟着结束。
//
// 这决定要不要「趁父进程还活着记下子孙 pid」那套机制：
// - 会跟着结束 → 不需要，停的时候连树杀就够了（那才是父进程还活着的时刻）
// - 不会 → 需要，正常结束的会话也会留下占着工作目录的进程
//
// 让 Agent 把一条 90 秒的命令放后台，然后立刻结束会话；会话结束后看那个进程还在不在
// （它以临时工作目录为 cwd，目录删得掉就说明它没了）。haiku，约 $0.02。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cwd = mkdtempSync(path.join(tmpdir(), "spike-exit-"));
const sleeper = "node -e \"setTimeout(()=>console.log('done'),90000)\"";
const log = [];
const started = Date.now();
const stamp = (text) => log.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${text}`);
// 非破坏性探测：改名成功就说明没人攥着它，改完立刻改回去，每次探测都是独立的
const removable = () => {
  const moved = `${cwd}-probe`;
  try {
    renameSync(cwd, moved);
    renameSync(moved, cwd);
    return "可删（进程没了）";
  } catch (error) {
    return `锁着 ${error.code}（进程还活着）`;
  }
};

const q = query({
  prompt: `用 Bash 后台运行 \`${sleeper}\`（run_in_background: true），拿到任务 id 后立刻只回复 ok，不要等它结束。`,
  options: {
    cwd,
    model: process.env.SPIKE_MODEL ?? "claude-haiku-4-5",
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxBudgetUsd: 0.3,
    env: { ...process.env, ANTHROPIC_API_KEY: undefined },
  },
});
for await (const m of q) {
  if (m.type === "system" && m.subtype === "task_started") stamp("后台命令起来了");
  if (m.type === "result") {
    stamp(`result:${m.subtype} cost=${m.total_cost_usd}`);
    break;
  }
}
q.close();
stamp(`close() 之后立刻：${removable()}`);
for (const wait of [2000, 3000, 5000]) {
  await new Promise((r) => setTimeout(r, wait));
  stamp(`再等 ${wait / 1000} 秒：${removable()}`);
}
rmSync(cwd, { recursive: true, force: true });
console.log(log.join("\n"));
