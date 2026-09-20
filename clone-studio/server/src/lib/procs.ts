import type { ChildProcess } from "node:child_process";

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
   * 杀掉属于某个对象的全部子进程，返回杀掉的个数。
   * 删除客户或模板前用它把还在跑的活儿停掉，不然目录会被占着删不动。
   */
  killBySubject(match: (subject: ProcSubject) => boolean): number {
    let killed = 0;
    for (const [, entry] of this.entries) {
      if (entry.subject && match(entry.subject)) {
        entry.child.kill("SIGTERM");
        killed += 1;
      }
    }
    return killed;
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
