import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 契约测试（11.2 审查 M3）：Codex Provider 包同步到数据根 node_modules 之后，真 hypit 从模板工作目录往上找得到它。
 *
 * 整个方案（不用 --package-root，见 codex-package.ts）押在 hypit 的一条行为上：非 @hypit 的包从工作目录往上
 * 逐级查 node_modules。hypit 哪天改了找包方式或 `@hypit/hypit/*` 的导入钩子，单测全绿，用户一打开 Codex，
 * 所有模板的估价与 whisperx 就一起坏——这组把它变成一条红的测试。hypit CLI 不在时整组跳过。
 * 不起 codex：plan 只解析 endpoint，不调用它。
 */

const HYPIT_CLI = path.resolve(process.cwd(), "..", "..", "hypit-main", "bin", "hypit.mjs");
const hasHypit = existsSync(HYPIT_CLI);

function hypit(dir: string, args: string[]) {
  const run = spawnSync(process.execPath, [HYPIT_CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  const out = run.stdout ?? "";
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`hypit 没有给出 JSON：${out}${run.stderr ?? ""}`);
  return { json: JSON.parse(out.slice(start)) as Record<string, unknown>, raw: out + (run.stderr ?? "") };
}

describe.skipIf(!hasHypit)("hypit 契约：数据根 node_modules 里的 Codex Provider 包", () => {
  let dataRoot: string;
  let dir: string;

  beforeAll(async () => {
    dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-codexcontract-"));
    process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
    const { syncCodexPackage } = await import("./codex-package.js");
    syncCodexPackage();
    const { createWorkspace } = await import("./workspace.js");
    dir = createWorkspace({
      clientId: "c-codex",
      templateId: "t-codex",
      slug: "codex-contract",
      services: {
        tokendance: false,
        hypihub: false,
        whisperx: true,
        renderWorkers: 1,
        renderConcurrency: 1,
        codex: { command: process.execPath, prefixArgs: ["never-run.js"] },
      },
    }).dir;
    writeFileSync(
      path.join(dir, "probe.svml"),
      `<?svml using="@hypit/markup@1"?>\n<svml>\n  <import as="text" from="@hypit/text@1"/>\n  <import as="gpt" from="@hypit/gpt-image@1"/>\n` +
        `  <text:Value id="look">A red apple.</text:Value>\n  <gpt:Image id="apple" prompt={look} aspect-ratio="1:1" resolution="1K"/>\n</svml>\n`,
    );
    writeFileSync(
      path.join(dir, "probe.svrun"),
      `<?svml using="@hypit/run-markup@1"?>\n<svrun version="1">\n  <author source="./probe.svml"/>\n  <target output="apple.image"/>\n</svrun>\n`,
    );
  }, 60_000);

  afterAll(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.CLONE_STUDIO_DATA_ROOT;
  });

  it("doctor 不报包解析错误；programs status 照常（whisperx 的 programs up 走的就是它）", () => {
    const doctor = hypit(dir, ["doctor", "--workspace", dir, "--json"]);
    expect(doctor.raw).not.toMatch(/cannot resolve installed package|RUNTIME_PACKAGE_SELECTION/u);
    const programs = hypit(dir, ["programs", "status", "--workspace", dir, "--json"]);
    expect(programs.json.ok, programs.raw).toBe(true);
  }, 120_000);

  it("plan 把 gpt-image-2 解析到 codex.local，零价（local）", () => {
    const plan = hypit(dir, ["plan", "probe.svrun", "--workspace", dir, "--json"]);
    const providers = plan.json.providers as Array<{
      capability: string;
      endpoint: string;
      status: string;
      pricing: { kind: string };
    }>;
    expect(providers, plan.raw).toEqual([
      expect.objectContaining({
        capability: "@hypit/gpt-image@1#gpt-image-2",
        endpoint: "codex.local",
        status: "resolved",
        pricing: { kind: "local" },
      }),
    ]);
  }, 120_000);
});

describe.skipIf(!hasHypit)("hypit 契约的反向对照（11.2 第二轮审查 L-d）", () => {
  it("不同步包：真 hypit 解析不到它——证明上面那组失效时真会红", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clone-studio-codexcontract-neg-"));
    const saved = process.env.CLONE_STUDIO_DATA_ROOT;
    process.env.CLONE_STUDIO_DATA_ROOT = root;
    try {
      const { vi } = await import("vitest");
      vi.resetModules();
      const { createWorkspace } = await import("./workspace.js");
      const dir = createWorkspace({
        clientId: "c-neg",
        templateId: "t-neg",
        slug: "codex-neg",
        services: {
          tokendance: false,
          hypihub: false,
          whisperx: true,
          renderWorkers: 1,
          renderConcurrency: 1,
          codex: { command: process.execPath, prefixArgs: ["never-run.js"] },
        },
      }).dir;
      const programs = hypit(dir, ["programs", "status", "--workspace", dir, "--json"]);
      expect(programs.raw).toMatch(/cannot resolve installed package @clone-studio\/codex-image/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (saved === undefined) delete process.env.CLONE_STUDIO_DATA_ROOT;
      else process.env.CLONE_STUDIO_DATA_ROOT = saved;
    }
  }, 120_000);
});
