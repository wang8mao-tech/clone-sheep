// Phase 5 开工实测二：settingSources: [] 时，能否经 plugins 选项加载 hypit skill。
// 官方文档：settingSources 不含 user/project 时 SDK 不从 .claude/skills 加载任何 skill；
// 出路是 plugins 选项指向本地插件目录。但文档没写 settingSources: [] 下插件是否仍加载——实测。
//
// 插件目录建在临时目录：.claude-plugin/plugin.json + skills/hypit/（从 hypit-main 复制）。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = process.env.SPIKE_MODEL ?? "claude-haiku-4-5";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = mkdtempSync(path.join(tmpdir(), "spike-plugin-"));
const workdir = path.join(root, "ws");
const plugin = path.join(root, "clone-studio-agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(plugin, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "clone-studio", version: "0.0.0", description: "Clone Studio 宿主给 Agent 预置的能力" }),
);
cpSync(path.join(repo, "hypit-main", "skills", "hypit"), path.join(plugin, "skills", "hypit"), { recursive: true });

async function run(label, extra) {
  const r = { label };
  try {
    for await (const m of query({
      prompt: "列出你能用的 skill 名称（只列名称，一行一个），然后结束。不要调用任何工具。",
      options: {
        model: MODEL,
        cwd: workdir,
        maxTurns: 2,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        ...extra,
      },
    })) {
      if (m.type === "system" && m.subtype === "init") {
        r.plugins = m.plugins;
        r.skills = (m.skills ?? []).filter((s) => /hypit/i.test(s));
        r.skillCount = (m.skills ?? []).length;
      }
      if (m.type === "result")
        r.result = { subtype: m.subtype, cost: m.total_cost_usd, text: String(m.result ?? "").slice(0, 300) };
    }
  } catch (e) {
    r.threw = String(e?.message ?? e);
  }
  return r;
}

const out = { root, runs: [] };
out.runs.push(await run("settingSources-empty-no-plugin", { settingSources: [] }));
out.runs.push(
  await run("settingSources-empty-with-plugin", { settingSources: [], plugins: [{ type: "local", path: plugin }] }),
);
console.log(JSON.stringify(out, null, 2));
rmSync(root, { recursive: true, force: true });
