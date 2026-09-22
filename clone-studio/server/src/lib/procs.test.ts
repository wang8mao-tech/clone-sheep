import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_LABEL, procs } from "./procs.js";

/**
 * 进程收尸决定了 Agent 会话停下之后还能不能删目录（AC-002）。这里全用真进程验。
 *
 * 孙进程都用 detached 起：不然本机上父进程一死它也跟着没了（继承同一个 job object），
 * 就分不出「只杀父进程」和「连子孙一起杀」——而真实的 Agent 会话里，Bash 起的进程
 * 确实在父进程之后还活着（scripts/spike-interrupt-cost.mjs 实测）。
 */

const started: Array<{ dir: string; child: ChildProcess }> = [];

/** 起一棵「父进程 + 占着临时目录的 detached 孙进程」 */
function spawnTree(): { dir: string; child: ChildProcess } {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-procs-"));
  const grandchild =
    `require("child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], ` +
    `{ cwd: ${JSON.stringify(dir)}, stdio: "ignore", detached: true }); setTimeout(()=>{}, 60000);`;
  const child = spawn(process.execPath, ["-e", grandchild], { stdio: "ignore", windowsHide: true });
  const tree = { dir, child };
  started.push(tree);
  return tree;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 目录删不掉就说明还有进程以它为工作目录 */
function removable(dir: string): string {
  try {
    rmSync(dir, { recursive: true, force: true });
    return "可删";
  } catch (error) {
    return `锁着 ${(error as NodeJS.ErrnoException).code}`;
  }
}

// 用例失败也要收干净：否则留一个 60 秒的孙进程和一个删不掉的临时目录
afterEach(() => {
  for (const { dir, child } of started.splice(0)) {
    if (child.pid !== undefined) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    // 句柄要等一会儿才真正释放：带重试，删不掉也不让清理本身把用例搞红
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 留个空目录比让用例报错强
    }
  }
});

describe.runIf(process.platform === "win32")("procs：连子孙一起收尸", () => {
  it("killTree：孙进程占着的工作目录，杀完就能删", async () => {
    const { dir, child } = spawnTree();
    procs.register(child, AGENT_LABEL);
    await settle(800);
    expect(removable(dir)).toMatch(/锁着/); // 前提：孙进程活着时目录锁着

    expect(await procs.killTree(child.pid as number)).toBe(true);
    await settle(300);
    expect(removable(dir)).toBe("可删");
  }, 20_000);

  it("删对象时按 subject 收尸：Agent 会话与 hypit 调用都连子孙一起杀（复审 S2-M2）", async () => {
    const agent = spawnTree();
    const hypit = spawnTree();
    procs.register(agent.child, AGENT_LABEL, { kind: "template", id: "t-1" });
    procs.register(hypit.child, "hypit build", { kind: "template", id: "t-1" });
    await settle(800);
    expect(removable(agent.dir)).toMatch(/锁着/);
    expect(removable(hypit.dir)).toMatch(/锁着/);

    expect(await procs.killBySubject((s) => s.kind === "template" && s.id === "t-1")).toBe(2);
    await settle(300);
    // 只发 SIGTERM 的话孙进程还活着，这两行就会是「锁着」
    expect(removable(agent.dir)).toBe("可删");
    expect(removable(hypit.dir)).toBe("可删");
  }, 30_000);

  it("父进程已经退了：不报错也不乱杀（正常结束的会话由 Claude Code 自己收掉后台命令，实测）", async () => {
    const { child } = spawnTree();
    procs.register(child, AGENT_LABEL, { kind: "template", id: "t-2" });
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await settle(500);
    expect(await procs.killBySubject((s) => s.id === "t-2")).toBe(0); // 登记表里已经没有它了
  }, 20_000);

  it("没登记的 pid：返回 false，不去乱杀", async () => {
    expect(await procs.killTree(999_999)).toBe(false);
  });

  // 放最后：killAll 会清空登记表并进入「正在关停」状态
  it("后端退出收尸：先连树杀再管父进程，孙进程不留（复审 S2-M1）", async () => {
    const { dir, child } = spawnTree();
    procs.register(child, AGENT_LABEL);
    await settle(800);
    expect(removable(dir)).toMatch(/锁着/);

    procs.killAll();
    await settle(500);
    expect(removable(dir)).toBe("可删");
  }, 20_000);
});
