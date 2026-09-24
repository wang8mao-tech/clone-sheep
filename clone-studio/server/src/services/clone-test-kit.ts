import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { RunInput, RunOutcome } from "../agent/runner.js";
import type { HypitRunOptions } from "../hypit/cli.js";

/** 2026-09-23 实跑成功的 build JSON 形状（scratchpad/render/build1.json） */
export const BUILD_OK = {
  format: "hypit.cli-build@1",
  build: {
    id: "bld_test_0001",
    targets: ["reference.video"],
    work: { state: "done", outcome: "complete" },
    result: { state: "complete", outputCount: 3 },
    // --verbose 下完成了的操作也在；本地渲染没有 receipt
    operations: [{ endpoint: "hyperframes.local", status: "completed" }],
  },
};

export interface FakeBuild {
  lines: string[];
  json: Record<string, unknown>;
}
export type SubmitBehaviour =
  | Error
  | Record<string, unknown>
  | ((options: HypitRunOptions) => Promise<Record<string, unknown> | Error> | Record<string, unknown> | Error);
export type BuildBehaviour =
  Error | FakeBuild | ((options: HypitRunOptions) => Promise<FakeBuild | Error> | FakeBuild | Error);
import { init, success } from "../agent/scheduler-test-kit.js";

/**
 * 复刻编排测试的公共底座：真临时库、真文件；Agent 会话换成手动控制的假 run，hypit 换成假的。
 * 每个用例一个临时数据根，用完关库再删。
 */

let dataRoot = "";
let closeDb: (() => void) | undefined;
let unregister: (() => void) | undefined;

export function useCloneSandbox(): void {
  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(tmpdir(), "cs-clone-"));
    process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
    vi.resetModules();
  });
  afterEach(async () => {
    (await import("./build-activity.js")).stopActivityWatcher();
    unregister?.();
    unregister = undefined;
    closeDb?.();
    closeDb = undefined;
    rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.CLONE_STUDIO_DATA_ROOT;
    vi.restoreAllMocks();
  });
}

export interface Call {
  input: RunInput;
  finish(outcome: RunOutcome): void;
}

/** hypit check 的假结果：给 Error 就抛，给函数就等它（验「核的过程中」），给对象就原样当 JSON */
export type CheckBehaviour = Error | Record<string, unknown> | (() => Promise<Record<string, unknown>>);

export const CHECK_OK = { format: "hypit.cli-check@1", ok: true, run: "reference.svrun", targetCount: 1 };

export async function boot(options: { register?: boolean } = {}) {
  const hypitCalls: string[][] = [];
  const hypitOptions: HypitRunOptions[] = [];
  let checkBehaviour: CheckBehaviour = CHECK_OK;
  /** 证据步骤里要让哪一步失败（"media probe" / "transcribe" / "media tiles"） */
  let failAt: { step: string; error: Error } | undefined;
  /** 估价用的 plan / pricing 假结果：给 Error 就抛；默认是「没有任何请求」的 plan */
  let planBehaviour: Error | Record<string, unknown> | (() => Promise<Record<string, unknown>>) = {
    format: "hypit.cli-plan@1",
    ok: true,
    providers: [],
    needs: [],
  };
  let pricingBehaviour: Error | Record<string, unknown> = { format: "hypit.cli-pricing@1", groups: [] };
  /** 假 build：先按行吐进度，再给最终 JSON；给函数就由用例决定何时结束（验取消 / 中途换视频） */
  let buildBehaviour: BuildBehaviour = { lines: [], json: BUILD_OK };
  /** 只给 status --watch 这一步用的行为（提交照常成功）；不设就沿用 buildBehaviour */
  let watchBehaviour: BuildBehaviour | undefined;
  /** 只给提交（build --json）这一步用的行为：给函数可以让提交挂住 / 抛错；不设就按 buildBehaviour 推 */
  let submitBehaviour: SubmitBehaviour | undefined;
  let getBehaviour:
    | Error
    | Record<string, unknown>
    | ((to: string, options: HypitRunOptions) => Promise<Record<string, unknown>> | Record<string, unknown>) = (to) => {
    writeFileSync(to, "fake mp4", "utf8");
    return { format: "hypit.cli-get@1", kind: "resource", path: to };
  };
  const cancelled: string[] = [];
  const cli = await import("../hypit/cli.js");
  vi.spyOn(cli, "runHypit").mockImplementation(async (args: readonly string[], options: HypitRunOptions) => {
    hypitCalls.push([...args]);
    hypitOptions.push(options);
    const reply = (json: unknown) => ({ json, exitCode: 0, stderr: "", durationMs: 1 });
    if (args[0] === "check") {
      if (checkBehaviour instanceof Error) throw checkBehaviour;
      return reply(typeof checkBehaviour === "function" ? await checkBehaviour() : checkBehaviour);
    }
    if (args[0] === "build") {
      if (submitBehaviour !== undefined) {
        const s = typeof submitBehaviour === "function" ? await submitBehaviour(options) : submitBehaviour;
        if (s instanceof Error) throw s;
        return reply(s);
      }
      // 提交：立刻给 build id（真 hypit 在 --json 下不带 --follow 就是这样）；Error 行为在这一步就炸
      if (buildBehaviour instanceof Error) throw buildBehaviour;
      const id =
        typeof buildBehaviour === "function"
          ? "bld_test_0001"
          : ((buildBehaviour.json as { build?: { id?: string } }).build?.id ?? "bld_test_0001");
      return reply({
        format: "hypit.cli-build@1",
        build: { id, targets: ["reference.video"], work: { state: "queued" } },
      });
    }
    if (args[0] === "status") {
      // 跟到结束：先按行吐进度，再给最终 JSON；给函数就由用例决定何时结束（验取消 / 中途换视频）
      const behaviour = watchBehaviour ?? buildBehaviour;
      const b = typeof behaviour === "function" ? behaviour(options) : behaviour;
      if (b instanceof Error) throw b;
      const resolved = await b;
      if (resolved instanceof Error) throw resolved;
      for (const line of resolved.lines) options.onStderrLine?.(line);
      return reply(resolved.json);
    }
    if (args[0] === "get") {
      if (getBehaviour instanceof Error) throw getBehaviour;
      const to = args[args.indexOf("--to") + 1] as string;
      return reply(typeof getBehaviour === "function" ? await getBehaviour(to, options) : getBehaviour);
    }
    if (args[0] === "cancel") {
      cancelled.push(args[1] as string);
      return reply({ format: "hypit.cli-cancel@1", requested: true });
    }
    if (args[0] === "plan") {
      if (planBehaviour instanceof Error) throw planBehaviour;
      return reply(typeof planBehaviour === "function" ? await planBehaviour() : planBehaviour);
    }
    if (args[0] === "pricing") {
      if (pricingBehaviour instanceof Error) throw pricingBehaviour;
      return reply(pricingBehaviour);
    }
    const step = args[0] === "media" ? `media ${args[1]}` : args[0];
    if (failAt && step === failAt.step) throw failAt.error;
    if (args[0] === "media" && args[1] === "probe") {
      return reply({ duration: 30, hasVideo: true, hasAudio: true, width: 1080, height: 1920, frameRate: 30 });
    }
    return reply({ ok: true });
  });
  const whisper = await import("../hypit/whisperx-service.js");
  vi.spyOn(whisper, "ensureWhisperX").mockResolvedValue("already-up");

  const dbMod = await import("../db/index.js");
  (await import("../db/migrate.js")).migrate();
  closeDb = dbMod.closeDb;
  const archive = await import("./archive.js");
  const service = await import("../agent/agent-service.js");
  const store = await import("../agent/job-store.js");
  const clone = await import("./clone.js");
  const verdicts = await import("./clone-verdicts.js");
  const evidence = await import("./evidence.js");
  const estimate = await import("./estimate-run.js");
  const rates = await import("./rates.js");
  const build = await import("./build-run.js");
  const activity = await import("./build-activity.js");
  const watcher = {
    started: 0,
    stopped: 0,
    push: (_line: string) => undefined as void,
    /** 模拟 watcher 进程自己退出（Worker 还没起来时 hypit activity 就是这样） */
    exit: () => undefined as void,
  };
  activity.setActivitySpawner((_dir, onLine, onExit) => {
    watcher.started += 1;
    watcher.push = onLine;
    watcher.exit = onExit;
    return {
      stop: () => {
        watcher.stopped += 1;
      },
    };
  });
  service.resetAgentScheduler();

  const calls: Call[] = [];
  service.agentScheduler({
    overrides: {
      run: (input) =>
        new Promise<RunOutcome>((resolve) => {
          input.stopSignal?.addEventListener("abort", () => resolve({ aborted: true }));
          calls.push({ input, finish: resolve });
        }),
      settings: () => ({ timeoutMinutes: 45, budgetUsd: 5, concurrency: 2 }),
      workspaceOf: (job) => service.workspaceOf(job),
    },
  });
  const register = () => {
    unregister = clone.registerCloneFlow();
  };
  if (options.register !== false) register();

  const client = archive.createClient("客户");
  const template = archive.createTemplate(client.id, "足球榜");
  const templateId = template.id;
  const workspace = template.workspace_path as string;
  const db = dbMod.db;
  return {
    archive,
    service,
    store,
    clone,
    verdicts,
    evidence,
    estimate,
    rates,
    build,
    watcher,
    cancelled,
    calls,
    hypitCalls,
    hypitOptions,
    db,
    templateId,
    workspace,
    register,
    setCheck: (next: CheckBehaviour) => {
      checkBehaviour = next;
    },
    setFail: (step: string, error: Error) => {
      failAt = { step, error };
    },
    setPlan: (next: Error | Record<string, unknown> | (() => Promise<Record<string, unknown>>)) => {
      planBehaviour = next;
    },
    setPricing: (next: Error | Record<string, unknown>) => {
      pricingBehaviour = next;
    },
    setBuild: (next: BuildBehaviour) => {
      buildBehaviour = next;
    },
    setWatch: (next: BuildBehaviour | undefined) => {
      watchBehaviour = next;
    },
    setSubmit: (next: SubmitBehaviour | undefined) => {
      submitBehaviour = next;
    },
    setGet: (next: typeof getBehaviour) => {
      getBehaviour = next;
    },
    setStatus: (status: string) => {
      db().prepare("UPDATE templates SET status = ?, language = 'zh' WHERE id = ?").run(status, templateId);
    },
    writeProducts: (files: readonly string[] = ["reference.svrun", "ANALYSIS.md", "TIMELINE.md"]) => {
      for (const file of files) writeFileSync(path.join(workspace, file), `# ${file}\n`, "utf8");
    },
    templateStatus: () =>
      (db().prepare("SELECT status FROM templates WHERE id = ?").get(templateId) as { status: string }).status,
    verdictCount: () =>
      (db().prepare("SELECT COUNT(*) AS n FROM clone_verdicts WHERE template_id = ?").get(templateId) as { n: number })
        .n,
    latestJob: () => store.latestJobOf("template", templateId),
    /** 让第 callIndex 个假会话以成功收尾，返回任务 id */
    finishRun: async (callIndex = 0) => {
      await until(() => calls.length > callIndex, "会话开跑");
      const call = calls[callIndex] as Call;
      call.input.onMessage(init(`s${callIndex}`) as never);
      call.finish({ sessionId: `s${callIndex}`, result: success(0.2) as never });
      await until(() => store.latestJobOf("template", templateId)?.status !== "running", "任务结束");
      return store.latestJobOf("template", templateId)?.id as string;
    },
  };
}

export type Booted = Awaited<ReturnType<typeof boot>>;

export const tick = () => new Promise((r) => setTimeout(r, 10));

export async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`等不到：${what}`);
}

export function uploadFile(): string {
  // resetModules 之后再动态 import 本底座会拿到一个 dataRoot 为空的新实例，文件就会写进仓库目录：直接拦
  if (!dataRoot) throw new Error("uploadFile 在沙箱之外被调用（dataRoot 为空）：要从测试文件顶部静态 import 本底座");
  const dir = path.join(dataRoot, "uploads");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `u-${Date.now()}.mp4`);
  writeFileSync(file, "not really a video", "utf8");
  return file;
}
