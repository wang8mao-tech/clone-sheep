import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexReadiness } from "../hypit/codex.js";

/**
 * Codex 订阅生图的宿主接入（REQ-011，Task 11.2）：启用开关按体检把关（AC-033）、体检行、「试出一张图」。
 * codex 本身、hypit 调用与包同步都换成桩：这里测的是宿主的流程，真链路在 11.5 真机验收里跑。
 */

let dataRoot: string;
let readiness: CodexReadiness;
let hypitCalls: string[][];
let onHypit: (args: readonly string[]) => Promise<{ json: unknown }>;
const syncCalls: number[] = [];
let packageProblem: string | null;

const READY: CodexReadiness = {
  ready: true,
  installed: true,
  version: "0.153.4",
  loggedIn: true,
  problem: null,
  fix: null,
};
const LOGGED_OUT: CodexReadiness = {
  ready: false,
  installed: true,
  version: "0.153.4",
  loggedIn: false,
  problem: "未登录",
  fix: "codex login",
};
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function okBuild(args: readonly string[]): Promise<{ json: unknown }> {
  if (args[0] === "build") {
    return Promise.resolve({
      json: { build: { id: "bld_try_1", targets: ["sample.image"], result: { state: "complete" } } },
    });
  }
  if (args[0] === "get") {
    const to = args[args.indexOf("--to") + 1] as string;
    writeFileSync(to, PNG);
  }
  return Promise.resolve({ json: { ok: true } });
}

beforeEach(async () => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "cs-codexroute-"));
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  readiness = READY;
  hypitCalls = [];
  onHypit = okBuild;
  syncCalls.length = 0;
  packageProblem = null;
  vi.resetModules();
  vi.doMock("../hypit/codex.js", async (original) => ({
    ...(await original<typeof import("../hypit/codex.js")>()),
    codexReadiness: async () => readiness,
    codexEndpoint: () => ({ command: "node", prefixArgs: ["C:/npm/codex.js"] }),
  }));
  vi.doMock("../hypit/codex-package.js", async (original) => ({
    ...(await original<typeof import("../hypit/codex-package.js")>()),
    syncCodexPackage: () => {
      syncCalls.push(1);
      return { dir: "x", written: [], removed: [] };
    },
    codexPackageProblem: () => packageProblem,
  }));
  vi.doMock("../hypit/cli.js", async (original) => ({
    ...(await original<typeof import("../hypit/cli.js")>()),
    runHypit: (args: readonly string[]) => {
      hypitCalls.push([...args]);
      return onHypit(args);
    },
  }));
});

afterEach(async () => {
  const db = await import("../db/index.js");
  db.closeDb();
  vi.doUnmock("../hypit/codex.js");
  vi.doUnmock("../hypit/codex-package.js");
  vi.doUnmock("../hypit/cli.js");
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

async function app() {
  (await import("../db/migrate.js")).migrate();
  const Fastify = (await import("fastify")).default;
  const server = Fastify();
  await server.register((await import("./settings.js")).settingsRoutes);
  await server.register((await import("./codex.js")).codexRoutes);
  const tries = await import("../services/codex-try.js");
  tries.resetCodexTry();
  return { server, tries };
}

describe("启用开关按体检把关（AC-033）", () => {
  it("未登录：409 带 codex login，设置不变，也不同步包", async () => {
    readiness = LOGGED_OUT;
    const { server } = await app();
    const res = await server.inject({ method: "PATCH", url: "/api/settings", payload: { codexProviderEnabled: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "CODEX_NOT_READY" });
    expect(res.json().error.message).toContain("codex login");
    expect((await server.inject({ url: "/api/settings" })).json().codexProviderEnabled).toBe(false);
    expect(syncCalls).toEqual([]);
    await server.close();
  });

  it("准备好了：同步 Provider 包再打开；关掉不查体检", async () => {
    const { server } = await app();
    const on = await server.inject({ method: "PATCH", url: "/api/settings", payload: { codexProviderEnabled: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json().codexProviderEnabled).toBe(true);
    expect(syncCalls).toEqual([1]);
    readiness = LOGGED_OUT;
    const off = await server.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { codexProviderEnabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().codexProviderEnabled).toBe(false);
    await server.close();
  });

  it("启用后工程目录的 Runtime Profile 把 gpt-image 绑到 codex.local；关掉就不绑", async () => {
    const { server } = await app();
    const { workspaceServices } = await import("../services/archive.js");
    expect(workspaceServices().codex).toBeNull();
    await server.inject({ method: "PATCH", url: "/api/settings", payload: { codexProviderEnabled: true } });
    expect(workspaceServices().codex).toEqual({ command: "node", prefixArgs: ["C:/npm/codex.js"] });
    // 开着、但包没同步上：不绑（否则每个模板的 plan 都解析不到包，11.2 审查 M1）
    packageProblem = "Provider 包没同步上：拒绝同步 Codex Provider：x 是链接";
    expect(workspaceServices().codex).toBeNull();
    await server.close();
  });
});

describe("体检行", () => {
  it("没准备好：warn、不挡别的操作、写原因与修法；准备好：pass 带版本", async () => {
    readiness = LOGGED_OUT;
    const { checkCodex } = await import("../health/checks.js");
    expect(await checkCodex()).toMatchObject({
      id: "codex",
      status: "warn",
      blocking: false,
      detail: "codex-cli 0.153.4 · 未登录",
      fix: "codex login",
      ready: false,
    });
    readiness = READY;
    expect(await checkCodex()).toMatchObject({
      status: "pass",
      detail: "codex-cli 0.153.4 · 已登录",
      fix: null,
      ready: true,
    });
  });

  it("CLI 与登录都好、Provider 包没同步上：不算通过，写出原因（11.2 审查 M1）", async () => {
    packageProblem = "Provider 包没同步上：找不到 Codex Provider 源码";
    const { checkCodex } = await import("../health/checks.js");
    expect(await checkCodex()).toMatchObject({
      status: "warn",
      detail:
        "codex-cli 0.153.4 · 已登录 · Provider 包没同步上：找不到 Codex Provider 源码（打开开关或试出一张图会重试同步）",
      fix: null,
      // 打开开关、试出一张图都会当场重试同步：界面据此照样让点（11.3 审查 S1-M1）
      ready: true,
    });
  });
});

describe("试出一张图", () => {
  it("走真实链路：临时工程绑 codex.local → build → get 导出 → runtime down；图能取到", async () => {
    const { server, tries } = await app();
    expect((await server.inject({ url: "/api/codex/try" })).json()).toEqual({ try: null });
    const started = await server.inject({ method: "POST", url: "/api/codex/try" });
    expect(started.statusCode).toBe(202);
    const id = started.json().try.id as string;
    expect(started.json().try.status).toBe("running");
    await tries.settleCodexTry();

    const state = (await server.inject({ url: "/api/codex/try" })).json().try;
    expect(state).toMatchObject({ id, status: "done", hasImage: true, error: null });
    expect(state.durationMs).toBeGreaterThanOrEqual(0);
    expect(hypitCalls.map((c) => c[0])).toEqual(["build", "get", "runtime"]);
    expect(hypitCalls[0]).toEqual(expect.arrayContaining(["try.svrun", "--follow", "--json"]));
    expect(hypitCalls[1]).toEqual(expect.arrayContaining(["bld_try_1", "--output", "sample.image"]));
    expect(hypitCalls[2]).toEqual(expect.arrayContaining(["down"]));

    const dir = path.join(dataRoot, "codex-try", id);
    const profile = JSON.parse(readFileSync(path.join(dir, "hypit.runtime.json"), "utf8"));
    expect(profile.bindings["@hypit/gpt-image@1#gpt-image-2"]).toBe("codex.local");
    expect(profile.endpoints["codex.local"].config).toMatchObject({ command: "node", concurrency: 1 });
    expect(readFileSync(path.join(dir, ".hypit", "runtime"), "utf8").trim()).toBe("hypit.runtime.json");
    expect(readFileSync(path.join(dir, "try.svrun"), "utf8")).toContain('output="sample.image"');
    expect(syncCalls).toEqual([1]);

    const image = await server.inject({ url: `/api/codex/try/${id}/image` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload.equals(PNG)).toBe(true);
    expect((await server.inject({ url: "/api/codex/try/other/image" })).statusCode).toBe(404);
    await server.close();
  });

  it("出图失败：原文进 error；导出不在也算失败；hypit 抛错也收住；都会 runtime down", async () => {
    const { server, tries } = await app();
    const run = async () => {
      hypitCalls = [];
      await server.inject({ method: "POST", url: "/api/codex/try" });
      await tries.settleCodexTry();
      expect(hypitCalls.at(-1)?.slice(0, 2)).toEqual(["runtime", "down"]);
      return (await server.inject({ url: "/api/codex/try" })).json().try;
    };

    onHypit = async (args) =>
      args[0] === "build"
        ? {
            json: {
              build: {
                id: "bld_x",
                failure: "Endpoint codex.local failed gpt-image-2: Codex 正常退出，但没有产出图片",
                result: { state: "failed" },
              },
            },
          }
        : { json: {} };
    expect(await run()).toMatchObject({
      status: "failed",
      hasImage: false,
      error: expect.stringContaining("没有产出图片"),
    });

    onHypit = async (args) => (args[0] === "get" ? { json: {} } : okBuild(args));
    expect(await run()).toMatchObject({ status: "failed", error: expect.stringContaining("导出的图片不在") });

    const { HypitError } = await import("../hypit/cli.js");
    onHypit = async (args) => {
      if (args[0] === "build")
        throw new HypitError("CLI_ERROR", "cannot resolve installed package @clone-studio/codex-image");
      return { json: {} };
    };
    const failed = await run();
    expect(failed.error).toContain("cannot resolve installed package");
    expect((await server.inject({ url: `/api/codex/try/${failed.id as string}/image` })).statusCode).toBe(404);
    await server.close();
  });

  it("一次只跑一个：在跑时再点 409；没准备好 409 且不建工程；只留最近一次的目录", async () => {
    const { server, tries } = await app();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    onHypit = async (args) => {
      if (args[0] === "build") await gate;
      return okBuild(args);
    };
    const first = (await server.inject({ method: "POST", url: "/api/codex/try" })).json().try.id as string;
    const again = await server.inject({ method: "POST", url: "/api/codex/try" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("TRY_RUNNING");
    release();
    await tries.settleCodexTry();

    readiness = LOGGED_OUT;
    const refused = await server.inject({ method: "POST", url: "/api/codex/try" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("CODEX_NOT_READY");
    expect(readdirSync(path.join(dataRoot, "codex-try"))).toEqual([first]);

    readiness = READY;
    onHypit = okBuild;
    const second = (await server.inject({ method: "POST", url: "/api/codex/try" })).json().try.id as string;
    await tries.settleCodexTry();
    expect(readdirSync(path.join(dataRoot, "codex-try"))).toEqual([second]);
    expect(existsSync(path.join(dataRoot, "codex-try", first))).toBe(false);
    await server.close();
  });
});

describe("试出一张图：后端重启留下的工程（11.2 审查 M2）", () => {
  it("开始前先对旧工程 runtime down 再删；启动时的清理同样做", async () => {
    const { server, tries } = await app();
    const stale = path.join(dataRoot, "codex-try", "stale-1");
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, "try.svrun"), "x");
    await server.inject({ method: "POST", url: "/api/codex/try" });
    await tries.settleCodexTry();
    const downs = hypitCalls.filter((c) => c[0] === "runtime" && c[1] === "down");
    expect(downs[0]).toEqual(expect.arrayContaining(["--workspace", stale]));
    expect(hypitCalls.findIndex((c) => c[0] === "runtime")).toBeLessThan(hypitCalls.findIndex((c) => c[0] === "build"));
    expect(existsSync(stale)).toBe(false);

    const orphan = path.join(dataRoot, "codex-try", "orphan-2");
    mkdirSync(orphan, { recursive: true });
    hypitCalls = [];
    expect(await tries.retireTryDirs()).toBeGreaterThanOrEqual(1);
    expect(hypitCalls.some((c) => c.includes(orphan))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    await server.close();
  });

  it.runIf(process.platform === "win32")(
    "旧工程被占着删不掉：409 以外的业务错误 TRY_PREPARE，带原文，不是裸 500",
    async () => {
      const { server } = await app();
      const stale = path.join(dataRoot, "codex-try", "locked-1");
      mkdirSync(stale, { recursive: true });
      // 有进程的当前目录在里面，Windows 上就删不掉（孤儿 Worker 占着工程目录时就是这样，审查实测 EPERM）
      const holder = spawn(process.execPath, ["-e", "console.log('ready'); setTimeout(() => {}, 30000)"], {
        cwd: stale,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // 等它真的起来、占住目录再发请求：机器忙时 spawn 返回了、进程还没进到这个目录（全套并行时偶发失败过）
      await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
      try {
        const res = await server.inject({ method: "POST", url: "/api/codex/try" });
        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe("TRY_PREPARE");
        expect(res.json().error.message).toContain("上一次的试图工程删不掉");
      } finally {
        holder.kill();
        await new Promise((r) => holder.once("exit", r));
      }
      await server.close();
    },
  );

  it("收尾的 runtime down 失败：记在这次的结果上，不静默吞掉", async () => {
    const { server, tries } = await app();
    onHypit = async (args) => {
      if (args[0] === "runtime") throw new Error("worker stop timed out");
      return okBuild(args);
    };
    await server.inject({ method: "POST", url: "/api/codex/try" });
    await tries.settleCodexTry();
    const state = (await server.inject({ url: "/api/codex/try" })).json().try;
    expect(state.status).toBe("done");
    expect(state.cleanup).toContain("worker stop timed out");
    await server.close();
  });
});
