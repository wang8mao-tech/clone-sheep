import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * hypit 调用自己超时 / 被中止时的收尸（Task 5.2 第四轮复审 S2-M6）。
 *
 * 用一个假 hypit：它再起一个 detached 的孙进程占住临时目录，自己不退出。超时之后那个
 * 目录必须删得掉——只对 hypit 发 SIGTERM 的话，Windows 上孙进程会活下来继续攥着它
 * （渲染时那就是 ffmpeg / Chromium）。
 */
let dataRoot: string;
let hypitRoot: string;
let held: string;
let closeDb: (() => void) | undefined;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "cs-cli-"));
  hypitRoot = path.join(dataRoot, "hypit-main");
  held = path.join(dataRoot, "held");
  mkdirSync(path.join(hypitRoot, "bin"), { recursive: true });
  mkdirSync(held, { recursive: true });
  writeFileSync(
    path.join(hypitRoot, "bin", "hypit.mjs"),
    `import { spawn } from "node:child_process";\n` +
      `spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], ` +
      `{ cwd: ${JSON.stringify(held)}, stdio: "ignore", detached: true });\n` +
      `setTimeout(() => {}, 60000);\n`,
  );
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  process.env.CLONE_STUDIO_HYPIT_ROOT = hypitRoot;
  vi.resetModules();
});

afterEach(() => {
  // 先关库：SQLite 在 Windows 上攥着文件句柄，不关整个数据根都删不掉
  closeDb?.();
  closeDb = undefined;
  delete process.env.CLONE_STUDIO_DATA_ROOT;
  delete process.env.CLONE_STUDIO_HYPIT_ROOT;
  try {
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 清理失败不该把用例判红
  }
});

describe("runHypit 的中止信号", () => {
  it("传进来的信号已经是中止状态：立刻停，不白等超时（复审 S2-L4）", async () => {
    const { runHypit } = await import("./cli.js");
    const { migrate } = await import("../db/migrate.js");
    const dbMod = await import("../db/index.js");
    closeDb = dbMod.closeDb;
    migrate();

    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    // 假 hypit 自己要跑 60 秒；超时设 30 秒。没处理「已经中止」的话这里至少要等 30 秒
    await expect(
      runHypit(["builds"], { cwd: dataRoot, timeoutMs: 30_000, signal: controller.signal }),
    ).rejects.toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 40_000);
});

describe.runIf(process.platform === "win32")("runHypit 的超时收尸", () => {
  it("超时之后连它起的子进程一起杀掉：占着的目录能删（复审 S2-M6）", async () => {
    const { runHypit } = await import("./cli.js");
    const { migrate } = await import("../db/migrate.js");
    const dbMod = await import("../db/index.js");
    closeDb = dbMod.closeDb;
    migrate(); // hypit_calls 落库要表在

    // 非破坏性探测：改名一个目录，成功了就说明没人攥着它，改完再改回去
    const locked = (): boolean => {
      const moved = `${held}-probe`;
      try {
        renameSync(held, moved);
        renameSync(moved, held);
        return false;
      } catch {
        return true;
      }
    };

    // 等孙进程真的占住目录再让它超时：固定睡 800ms 在整套测试并行跑、机器忙时不够（6.4 收尾时 pnpm check 两次撞上）
    const settle = async (want: boolean, deadlineMs: number): Promise<boolean> => {
      const until = Date.now() + deadlineMs;
      while (Date.now() < until) {
        if (locked() === want) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return locked() === want;
    };
    const call = runHypit(["builds"], { cwd: dataRoot, timeoutMs: 6_000 });
    expect(await settle(true, 5_000), "前提：孙进程起来了并占着目录").toBe(true);

    await expect(call).rejects.toMatchObject({ code: "TIMEOUT" });
    // 只杀 hypit 自己的话，这里永远等不到 false
    expect(await settle(false, 5_000)).toBe(true);
  }, 30_000);
});
