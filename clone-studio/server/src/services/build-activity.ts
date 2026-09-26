import { spawn, type ChildProcess } from "node:child_process";
import { paths } from "../config.js";
import { procs } from "../lib/procs.js";

/**
 * `hypit activity --watch --jsonl`：Runtime 侧的结构化进度（每个活跃 build 的阶段计数、请求完成数），
 * 与 `status --watch` 的进度行互补——进度行是"这一次看"看到的，activity 是 Worker 自己报的。
 *
 * 每个工作目录（= 一个 Runtime）一个 watcher：有 build 在跑就开着，没了就停。渲染并发大于 1 时不同模板
 * 各自一个，帧里的 build id 只在自己的 Runtime 里找，不会把别的模板的 build 当成自己的。
 * 帧的形状照 hypit-main/packages/cli/src/machine-view.ts：
 * `{ format: "hypit.cli-activity@1", at, worker, builds: [{ id, work: { state, requests? }, phases: { "rendering frames": 1 } }] }`
 */

export interface ActivityBuild {
  id: string;
  work: { state?: string; requests?: { total: number; completed: number } };
  phases: Record<string, number>;
}

export interface ActivityFrame {
  at: number;
  worker: string;
  builds: ActivityBuild[];
}

export type ActivitySpawner = (dir: string, onLine: (line: string) => void, onExit: () => void) => { stop: () => void };

/** watcher 进程退出后多久再起一个：Worker 还没起来时 `hypit activity` 会直接退出，提交完 Worker 起来了就能接上 */
const RESPAWN_DELAY_MS = 2_000;

/** 真实的 watcher：spawn hypit 子进程，按行读 stdout。测试里换成假的 */
const realSpawner: ActivitySpawner = (dir, onLine, onExit) => {
  // 与 hypit/cli.ts 同一种起法：node <hypit.mjs> …，shell: false，清掉 Agent SDK 留下的 NODE_OPTIONS
  const child: ChildProcess = spawn(
    process.execPath,
    [paths.hypitCli, "activity", "--workspace", dir, "--watch", "--jsonl"],
    {
      cwd: dir,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );
  procs.register(child, "hypit activity");
  let pending = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onLine(line);
  });
  child.on("exit", onExit);
  return {
    stop: () => {
      void procs.killTree(child.pid ?? -1);
    },
  };
};

let spawner: ActivitySpawner = realSpawner;
const watchers = new Map<
  string,
  { handle: { stop: () => void }; latest: ActivityFrame | null; respawn: NodeJS.Timeout | null }
>();

export function setActivitySpawner(next: ActivitySpawner | null): void {
  spawner = next ?? realSpawner;
}

/** 这个工作目录有 build 在跑时保证 watcher 开着 */
export function ensureActivityWatcher(dir: string): void {
  if (watchers.has(dir)) return;
  const state = {
    handle: { stop: () => undefined as void },
    latest: null as ActivityFrame | null,
    respawn: null as NodeJS.Timeout | null,
  };
  watchers.set(dir, state);
  const onLine = (line: string): void => {
    try {
      const frame = JSON.parse(line) as Partial<ActivityFrame> & { format?: unknown };
      if (frame.format !== "hypit.cli-activity@1" || !Array.isArray(frame.builds)) return;
      state.latest = {
        at: typeof frame.at === "number" ? frame.at : Date.now(),
        worker: String(frame.worker ?? ""),
        builds: frame.builds,
      };
    } catch {
      // 不是 JSON 的行（hypit 的提示）跳过
    }
  };
  const start = (): void => {
    state.handle = spawner(dir, onLine, () => {
      // 进程自己退了（Worker 还没起来、或被 hypit 关掉）：只要这个目录还在被看，过一会儿再起
      if (watchers.get(dir) !== state) return;
      state.latest = null;
      state.respawn = setTimeout(() => {
        state.respawn = null;
        if (watchers.get(dir) === state) start();
      }, RESPAWN_DELAY_MS);
      state.respawn.unref?.();
    });
  };
  start();
}

/** 停掉某个工作目录的 watcher；不带参数停全部（进程退出、测试收尾） */
export function stopActivityWatcher(dir?: string): void {
  const dirs = dir === undefined ? [...watchers.keys()] : [dir];
  for (const d of dirs) {
    const state = watchers.get(d);
    if (!state) continue;
    watchers.delete(d);
    if (state.respawn) clearTimeout(state.respawn);
    state.handle.stop();
  }
}

export function latestActivity(dir: string): ActivityFrame | null {
  return watchers.get(dir)?.latest ?? null;
}

/**
 * 给某个正在跑的 build 找它在 activity 里的那条：按 hypit build id 对；id 还不知道时（提交刚返回前）
 * 只有一个活跃 build 才当是它，否则不猜
 */
export function activityFor(dir: string, hypitBuildId: string | null): ActivityBuild | null {
  const latest = latestActivity(dir);
  if (!latest) return null;
  if (hypitBuildId) return latest.builds.find((b) => b.id === hypitBuildId) ?? null;
  return latest.builds.length === 1 ? (latest.builds[0] ?? null) : null;
}
