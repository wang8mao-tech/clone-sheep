import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** 强杀后等 exit 事件的宽限，超过就不等了 */
const FORCE_KILL_GRACE_MS = 2_000;

/** 连子孙一起强杀。Windows 只能借 taskkill，POSIX 走进程组。 */
function forceKillTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // 进程可能已经自己退了，杀不到就是好事
  }
}

/** 子进程归属哪个对象。删除客户/模板时要按它定位并中止（REQ-001 MUST）。 */
export interface ProcSubject {
  kind: string;
  id: string;
}

interface Entry {
  child: ChildProcess;
  label: string;
  subject?: ProcSubject;
  startedAt: number;
}

/**
 * 子进程登记表。
 *
 * 所有 spawn 出去的东西（hypit CLI、Codex、Agent SDK 的 Claude Code）都要登进来，
 * 后端退出时统一收尸。否则杀掉后端会留下一堆孤儿渲染进程接着吃 CPU 和显存。
 */
class ProcRegistry {
  private readonly entries = new Map<number, Entry>();
  private shuttingDown = false;

  register(child: ChildProcess, label: string, subject?: ProcSubject): void {
    const pid = child.pid;
    if (pid === undefined) return;
    this.entries.set(pid, { child, label, subject, startedAt: Date.now() });
    child.once("exit", () => this.entries.delete(pid));
  }

  get size(): number {
    return this.entries.size;
  }

  list(): Array<{ pid: number; label: string; subject?: ProcSubject; elapsedMs: number }> {
    const now = Date.now();
    return [...this.entries].map(([pid, e]) => ({
      pid,
      label: e.label,
      subject: e.subject,
      elapsedMs: now - e.startedAt,
    }));
  }

  /**
   * 杀掉属于某个对象的全部子进程，**等它们真的退出**再返回，返回杀掉的个数。
   *
   * 必须等：AC-002 的原话是「Agent 进程已结束再删目录」。发完 SIGTERM 就走的话，
   * 进程还攥着工作目录里的文件句柄，紧接着的 renameSync 会撞 EPERM，
   * 表现成随机的 DIRECTORY_BUSY。
   */
  async killBySubject(match: (subject: ProcSubject) => boolean, timeoutMs = 10_000): Promise<number> {
    const targets = [...this.entries].filter(([, entry]) => entry.subject && match(entry.subject));
    await Promise.all(targets.map(([pid, entry]) => this.terminate(pid, entry, timeoutMs)));
    return targets.length;
  }

  /** 发 SIGTERM 等退出；超时未退就连子孙进程一起强杀 */
  private terminate(pid: number, entry: Entry, timeoutMs: number): Promise<void> {
    const { child } = entry;
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      child.once("exit", finish);
      child.kill("SIGTERM");

      const timer = setTimeout(() => {
        // Windows 上 SIGKILL 对不肯退的进程一样没用，而 hypit 渲染会拉起一串
        // 孙进程，只杀父进程会留下占着目录的孤儿——必须带 /T 杀整棵树
        forceKillTree(pid);
        // 强杀后再给一点时间收 exit 事件；还不来就不等了，
        // 真没退的话后面移目录会撞 EPERM，照常报 DIRECTORY_BUSY
        setTimeout(finish, FORCE_KILL_GRACE_MS);
      }, timeoutMs);
    });
  }

  /** 按 pid 杀单个，用于"取消"动作 */
  kill(pid: number): boolean {
    const entry = this.entries.get(pid);
    if (!entry) return false;
    entry.child.kill("SIGTERM");
    return true;
  }

  killAll(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const [, entry] of this.entries) {
      // Windows 上 SIGTERM 等价于强杀，这里不做优雅等待——后端都要退了
      entry.child.kill("SIGTERM");
    }
    this.entries.clear();
  }
}

export const procs = new ProcRegistry();
