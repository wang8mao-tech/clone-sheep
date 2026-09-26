import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 杀进程树不能卡住后端（Task 9.4）：taskkill /T 要枚举整棵进程树，机器忙时几百毫秒到几十秒。
 * 平时的路径（出片收尸、停 Agent、删对象）异步起 taskkill、等它结束但不堵事件循环；
 * 只有后端退出收尸（killAll）同步等，因为进程马上要没了。
 * 真杀进程的行为由 procs.test.ts 用真进程验；这里看起 taskkill 的方式和等待的时机。
 */

const calls = vi.hoisted(() => ({
  spawn: [] as string[][],
  spawnSync: [] as string[][],
  /** 给了就用假的 taskkill：立刻杀掉目标，过这么久才报自己结束 */
  lateKillerMs: 0,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: ((cmd: string, args: readonly string[], opts: object) => {
      if (cmd !== "taskkill") return real.spawn(cmd, args, opts);
      calls.spawn.push([cmd, ...args]);
      if (!calls.lateKillerMs) return real.spawn(cmd, args, opts);
      const fake = new EventEmitter();
      process.kill(Number(args[1]));
      setTimeout(() => fake.emit("exit", 0), calls.lateKillerMs);
      return fake;
    }) as typeof real.spawn,
    spawnSync: ((cmd: string, args: readonly string[], opts: object) => {
      if (cmd === "taskkill") calls.spawnSync.push([cmd, ...args]);
      return real.spawnSync(cmd, args, opts);
    }) as typeof real.spawnSync,
  };
});

const children: ChildProcess[] = [];
async function sleeper(): Promise<ChildProcess> {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore", windowsHide: true });
  children.push(child);
  await new Promise((r) => child.once("spawn", r));
  return child;
}

beforeEach(() => {
  // killAll 会把登记表置成「正在关停」：每条用例一份新的
  vi.resetModules();
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  calls.spawn.length = 0;
  calls.spawnSync.length = 0;
  calls.lateKillerMs = 0;
});

describe.runIf(process.platform === "win32")("杀进程树不卡事件循环", () => {
  it("killTree：异步起 taskkill /T /F，不用 spawnSync；杀的过程中事件循环照常转", async () => {
    const { procs } = await import("./procs.js");
    const child = await sleeper();
    procs.register(child, "hypit build");
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    expect(await procs.killTree(child.pid as number)).toBe(true);
    clearInterval(timer);
    // 负载高时宽限可能先到期：确认的是「进程确实没了」这件事，不和 exit 事件的派发顺序赛跑（9.4 第二轮审查 S2-M1）
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    expect(calls.spawnSync).toEqual([]);
    expect(calls.spawn).toEqual([["taskkill", "/PID", String(child.pid), "/T", "/F"]]);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(ticks).toBeGreaterThan(0);
  });

  it("父进程先退了、taskkill 还没结束：等 taskkill 结束才返回（删目录前孙进程要杀完，9.4 审查 S2-M1）", async () => {
    const { procs } = await import("./procs.js");
    const child = await sleeper();
    procs.register(child, "agent");
    calls.lateKillerMs = 400;
    const started = Date.now();
    await procs.killTree(child.pid as number);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it("killAll（后端退出）：同步等 taskkill，免得进程先没了", async () => {
    const { procs } = await import("./procs.js");
    const child = await sleeper();
    procs.register(child, "hypit build");
    procs.killAll();
    expect(calls.spawnSync).toEqual([["taskkill", "/PID", String(child.pid), "/T", "/F"]]);
    expect(calls.spawn).toEqual([]);
  });
});
