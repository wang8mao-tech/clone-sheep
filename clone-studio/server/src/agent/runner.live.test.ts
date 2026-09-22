import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * AC-007 真机：用我们自己的 runner + session + guard 开一次真会话，让 Agent 去跑 build。
 *
 * 会花订阅额度，默认跳过；设 CLONE_STUDIO_LIVE_AGENT=1 才跑（haiku，约 $0.02）。
 * 全程临时目录；hypit 是假的——真被执行会在自己目录留 BUILD_RAN 标记，不会花任何钱。
 */
const live = process.env.CLONE_STUDIO_LIVE_AGENT === "1";

describe.skipIf(!live)("AC-007 真机：Agent 跑 hypit build 被宿主 hook 挡下", () => {
  let root: string;
  let ws: string;
  let marker: string;
  let fakeHypit: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "cs-live-agent-"));
    process.env.CLONE_STUDIO_DATA_ROOT = path.join(root, "data");
    ws = path.join(root, "ws");
    mkdirSync(ws, { recursive: true });
    // 目录名带空格：生产默认路径就是 X:\workflow\clone workflow\hypit-main，首轮审查就栽在这
    const bin = path.join(root, "fake hypit", "bin");
    mkdirSync(bin, { recursive: true });
    fakeHypit = path.join(bin, "hypit.mjs");
    marker = path.join(bin, "BUILD_RAN");
    writeFileSync(
      fakeHypit,
      `import { writeFileSync } from "node:fs";\nif (process.argv.includes("build")) writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
    vi.resetModules();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.CLONE_STUDIO_DATA_ROOT;
  });

  it("命令未执行、宿主拦截日志有记录、会话正常结束", async () => {
    const { runAgent } = await import("./runner.js");
    const intercepts: { rule: string; tool: string }[] = [];
    let skills: string[] = [];
    const node = process.execPath.replace(/\\/g, "/");
    const outcome = await runAgent({
      workspace: ws,
      model: "claude-haiku-4-5",
      maxBudgetUsd: 0.5,
      prompt: `用 Bash 运行 \`"${node}" "${fakeHypit.replace(/\\/g, "/")}" build demo.svrun\`。被拒绝就照实报告原因，不要换写法重试。`,
      onIntercept: (d) => intercepts.push(d),
      onMessage: (m) => {
        if (m.type === "system" && m.subtype === "init") skills = m.skills;
      },
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.sessionId).toBeTruthy();
    expect(existsSync(marker)).toBe(false);
    // skills: ["clone-studio:hypit"] 真把它放进来了（只放行它，不是把它也关掉）
    expect(skills).toContain("clone-studio:hypit");
    expect(intercepts).toEqual([expect.objectContaining({ rule: "hypit-command", tool: "Bash" })]);
    // 生成模型花费为 0：被拦下的是 hypit build，Agent 自己的对话花费另计
    expect(outcome.result?.total_cost_usd).toBeLessThan(0.5);
  }, 180_000);

  it("hypit 在 Agent 的 PATH 上：直接敲 `hypit --version` 就能跑通（复审 S1-H6）", async () => {
    const { runAgent } = await import("./runner.js");
    const { paths } = await import("../config.js");
    const expected = execFileSync(process.execPath, [paths.hypitCli, "--version"], { encoding: "utf8" }).trim();
    const intercepts: unknown[] = [];
    const outcome = await runAgent({
      workspace: ws,
      model: "claude-haiku-4-5",
      maxBudgetUsd: 0.5,
      prompt: "用 Bash 运行 `hypit --version`，只回复它输出的版本号，不要做别的。",
      onIntercept: (d) => intercepts.push(d),
      onMessage: () => {},
    });
    expect(outcome.error).toBeUndefined();
    expect(intercepts).toEqual([]);
    expect(outcome.result?.subtype).toBe("success");
    expect(outcome.result?.subtype === "success" ? outcome.result.result : "").toContain(expected);
  }, 180_000);

  it("宿主停下正在跑长命令的会话：拿到带花费的 result，Agent 起的子进程被带走（Task 5.2 复审）", async () => {
    const { runAgent } = await import("./runner.js");
    const stop = new AbortController();
    const stopWs = path.join(root, "stop-ws");
    mkdirSync(stopWs, { recursive: true });
    const sleeper = "node -e \"setTimeout(()=>console.log('done'),60000)\"";
    const outcome = await runAgent({
      workspace: stopWs,
      model: "claude-haiku-4-5",
      maxBudgetUsd: 0.5,
      prompt: `用 Bash 在前台运行 \`${sleeper}\`（不要放后台），等它输出 done 后只回复 ok。`,
      stopSignal: stop.signal,
      onIntercept: () => {},
      onMessage: (m) => {
        // 命令真跑起来之后再停
        if (m.type === "system" && m.subtype === "task_started") setTimeout(() => stop.abort(), 3000);
      },
    });
    expect(outcome.aborted).toBe(true);
    expect(outcome.result?.total_cost_usd).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1000));
    // 子进程还活着的话，它以此为工作目录，删不掉（EPERM）
    expect(() => rmSync(stopWs, { recursive: true, force: true })).not.toThrow();
  }, 180_000);
});
