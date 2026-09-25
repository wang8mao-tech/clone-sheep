import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { codexEndpoint, codexReadiness } from "../hypit/codex.js";
import { syncCodexPackage } from "../hypit/codex-package.js";
import { HypitError, runHypit } from "../hypit/cli.js";
import { buildRuntimeProfile } from "../hypit/runtime-profile.js";
import { ensureRuntimeSelected, PROFILE_FILENAME } from "../hypit/workspace.js";
import { sseHub } from "../lib/sse.js";
import { judgeBuild } from "./build-progress.js";

/**
 * 设置页「试出一张图」（REQ-011）：走真实路径——临时 hypit 工程里只有一个 gpt:Image，Runtime Profile
 * 把它绑到 Codex Provider，`hypit build` 出图、`hypit get` 导出。证明的是整条链（包能加载、codex 起得来、
 * 图能回到 Build），不是单独调一下 codex。
 *
 * 一次只跑一个；工程目录放在数据根下（hypit 靠往上找 `node_modules` 找到 Provider 包），只留最近一次。
 * 跑完 `hypit runtime down`：这个工程的 Worker 不该一直挂着。
 */

export class CodexTryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface CodexTryView {
  id: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  error: string | null;
  hasImage: boolean;
  /** 收尾停 Worker 没成功的原文（出图结果不受影响，但 Worker 可能还挂着） */
  cleanup: string | null;
}

interface Current {
  view: CodexTryView;
  dir: string;
  image: string | null;
  done: Promise<void>;
}

let current: Current | null = null;
/** 体检与准备工程是异步的：同时来两个请求时，只放第一个进去 */
let starting = false;

const TARGET = "sample.image";
const BUILD_WAIT_MS = 12 * 60_000;

export function codexTryRoot(): string {
  return path.join(config.dataRoot, "codex-try");
}

export function codexTryState(): CodexTryView | null {
  return current ? { ...current.view } : null;
}

export function codexTryImage(id: string): string | null {
  return current && current.view.id === id && current.image ? current.image : null;
}

/** 测试用：等当前这次跑完 */
export async function settleCodexTry(): Promise<void> {
  await current?.done;
}

/** 测试用 */
export function resetCodexTry(): void {
  current = null;
  starting = false;
}

const SVML = `<?svml using="@hypit/markup@1"?>

<svml>
  <import as="text" from="@hypit/text@1"/>
  <import as="gpt" from="@hypit/gpt-image@1"/>
  <text:Value id="look">A red apple on a white table, soft studio light, photographed from the front.</text:Value>
  <gpt:Image id="sample" prompt={look} aspect-ratio="1:1" resolution="1K"/>
</svml>
`;

const SVRUN = `<?svml using="@hypit/run-markup@1"?>
<svrun version="1">
  <author source="./try.svml"/>
  <target output="${TARGET}"/>
</svrun>
`;

/**
 * 收掉之前的试图工程：先 runtime down 再删（11.2 审查 M2）。后端在出图途中重启时，hypit 的 Worker 是
 * detached 的、还活着（codex 也照样在花额度），内存里的状态却没了——不先停它，Windows 上目录还被占着删不掉。
 * 启动时跑一次，每次开始试图前也跑一次；删不掉的抛出来，由调用方说清楚。返回收掉的个数。
 */
export async function retireTryDirs(): Promise<number> {
  const root = codexTryRoot();
  if (!existsSync(root)) return 0;
  let retired = 0;
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    await runHypit(["runtime", "down", "--workspace", dir, "--json"], {
      cwd: dir,
      subject: { kind: "codex-try", id: name },
      timeoutMs: 60_000,
    }).catch(() => {
      /* 没有 Worker 或已经停了 */
    });
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      throw new Error(`上一次的试图工程删不掉（${dir}）：${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    retired += 1;
  }
  return retired;
}

function prepareProject(id: string, endpoint: NonNullable<ReturnType<typeof codexEndpoint>>): string {
  const root = codexTryRoot();
  mkdirSync(root, { recursive: true });
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "clone-studio-codex-try", version: "0.0.0", private: true, type: "module" }, null, 2)}\n`,
  );
  const profile = buildRuntimeProfile({
    tokendance: false,
    hypihub: false,
    whisperx: false,
    renderWorkers: 1,
    renderConcurrency: 1,
    codex: endpoint,
  });
  writeFileSync(path.join(dir, PROFILE_FILENAME), `${JSON.stringify(profile, null, 2)}\n`);
  ensureRuntimeSelected(dir);
  writeFileSync(path.join(dir, "try.svml"), SVML);
  writeFileSync(path.join(dir, "try.svrun"), SVRUN);
  return dir;
}

function failText(error: unknown): string {
  if (error instanceof HypitError) return [error.message, error.help].filter(Boolean).join("\n");
  return error instanceof Error ? error.message : String(error);
}

async function execute(entry: Current): Promise<void> {
  const { dir, view } = entry;
  const subject = { kind: "codex-try", id: view.id };
  const finish = (patch: Partial<CodexTryView>) => {
    const endedAt = new Date();
    Object.assign(
      view,
      { endedAt: endedAt.toISOString(), durationMs: endedAt.getTime() - Date.parse(view.startedAt) },
      patch,
    );
    sseHub.publish("global", "codex-try", { id: view.id, status: view.status });
  };
  try {
    const built = await runHypit(
      ["build", "try.svrun", "--workspace", dir, "--follow", "--max-wait-ms", String(BUILD_WAIT_MS), "--json"],
      { cwd: dir, subject, timeoutMs: BUILD_WAIT_MS + 60_000 },
    );
    const verdict = judgeBuild(built.json);
    if (verdict.outcome !== "complete" || !verdict.buildId) {
      finish({ status: "failed", error: verdict.failure ?? `出图没有完成（${verdict.outcome}）` });
      return;
    }
    const image = path.join(dir, "sample.png");
    await runHypit(["get", verdict.buildId, "--output", TARGET, "--to", image, "--workspace", dir, "--json"], {
      cwd: dir,
      subject,
      timeoutMs: 5 * 60_000,
    });
    if (!existsSync(image) || statSync(image).size === 0) {
      finish({ status: "failed", error: "出图完成了，但导出的图片不在或是空的" });
      return;
    }
    entry.image = image;
    finish({ status: "done", hasImage: true });
  } catch (error) {
    finish({ status: "failed", error: failText(error) });
  } finally {
    try {
      await runHypit(["runtime", "down", "--workspace", dir, "--json"], { cwd: dir, subject, timeoutMs: 60_000 });
    } catch (error) {
      // 没停掉就记下来：下一次试图或下次启动时 retireTryDirs 还会再停一次（11.2 审查 M2）
      view.cleanup = `Worker 没停掉：${failText(error)}`;
    }
  }
}

export async function startCodexTry(): Promise<CodexTryView> {
  if (starting || current?.view.status === "running") throw new CodexTryError("TRY_RUNNING", "上一张还在出", 409);
  starting = true;
  try {
    return await begin();
  } finally {
    starting = false;
  }
}

async function begin(): Promise<CodexTryView> {
  const ready = await codexReadiness();
  if (!ready.ready) {
    throw new CodexTryError(
      "CODEX_NOT_READY",
      `Codex 没准备好：${ready.problem ?? "未知原因"}${ready.fix ? `（执行 ${ready.fix}）` : ""}`,
      409,
    );
  }
  const endpoint = codexEndpoint();
  if (!endpoint) throw new CodexTryError("CODEX_NOT_READY", "找不到 codex 命令", 409);
  const id = randomUUID();
  let dir: string;
  try {
    syncCodexPackage();
    await retireTryDirs();
    dir = prepareProject(id, endpoint);
  } catch (error) {
    // 准备阶段的失败带原文说清楚，不是一个没有业务码的 500（11.2 审查 M2）
    throw new CodexTryError("TRY_PREPARE", failText(error), 500);
  }
  const view: CodexTryView = {
    id,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    error: null,
    hasImage: false,
    cleanup: null,
  };
  const entry: Current = { view, dir, image: null, done: Promise.resolve() };
  current = entry;
  entry.done = execute(entry);
  sseHub.publish("global", "codex-try", { id, status: "running" });
  return { ...view };
}
