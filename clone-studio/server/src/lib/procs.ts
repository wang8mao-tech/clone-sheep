import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** Agent 会话进程的登记名：删对象时按它判定要不要连子孙一起杀 */
export const AGENT_LABEL = "agent";

/** 强杀后等 exit 事件的宽限，超过就不等了 */
const FORCE_KILL_GRACE_MS = 2_000;

/**
 * 连子孙一起强杀。
 *
 * Windows 用 taskkill /T 杀整棵树——hypit 渲染会拉起一串孙进程，
 * 只杀父进程会留下占着工作目录的孤儿。
 *
 * POSIX 这边不能用 `process.kill(-pid)` 杀进程组：spawn 时没给 `detached: true`
 * （见 hypit/cli.ts），子进程不是进程组长，它的 PGID 继承自后端自己，
 * 拿 -pid 去杀要么 ESRCH 被静默吞掉、要么 PID 复用时误伤无关进程组。
 * v1 只跑本机 Windows（Spec OUT-002），POSIX 这条路退回只杀进程本身，
 * 宁可漏掉孙进程也不能杀错人。
 */
function forceKillTree(child: ChildProcess, pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
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
 * 这里只按树杀，不维护「父进程还活着时记下的子孙 pid」那种名单。
 *
 * 宿主主动收尸的时刻（停任务、删对象、后端退出），父进程还在登记表里，`taskkill /T`
 * 枚举得到整棵树。而会话正常结束时，Claude Code 会收掉它经 Bash 后台任务起的进程
 * （2026-09-23 实测 scripts/spike-exit-children.mjs：close() 之后约 5 秒内那个进程就没了）。
 *
 * 残留风险，认了：会话正常结束之后登记表里就没有它了（exit 时删），这时若还有它没管住的
 * 后代（Agent 自己 detach 出去的、或 Claude Code 崩溃留下的），宿主收不到——删目录会撞
 * EPERM，报 DIRECTORY_BUSY 并回滚，用户重试即可。比存一份会过期的 pid 名单强：那份名单
 * 在 pid 被系统复用之后会杀错无关进程。
 */

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

  /**
   * 停掉一个登记过的进程并等它退出。Windows 一律连子孙一起杀，POSIX 先 SIGTERM
   * 再超时强杀。更体面的停法是调度器的 stopOwner（interrupt），这里是删对象时的兜底。
   */
  private terminate(pid: number, entry: Entry, timeoutMs: number): Promise<void> {
    const { child } = entry;
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    // Windows 上 SIGTERM 就是 TerminateProcess：父进程一瞬间没掉，之后 taskkill /T 找不到
    // 任何子孙（实测「先 SIGTERM 再 /T」＝留孤儿，「先 /T」＝干净）。所以一律先连树杀，
    // SIGTERM 那条只留给 POSIX——那里信号是可捕获的，值得给一次体面退出的机会
    if (process.platform === "win32") return this.killTree(pid, timeoutMs).then(() => undefined);

    return new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        // 两个定时器和监听器都要摘干净：先退出时留着宽限定时器会把事件循环
        // 多拽住 2 秒，超时路径留着监听器则是每杀一次泄漏一个
        clearTimeout(killTimer);
        clearTimeout(graceTimer);
        child.off("exit", finish);
        resolve();
      };

      child.once("exit", finish);
      child.kill("SIGTERM");

      killTimer = setTimeout(() => {
        forceKillTree(child, pid);
        // 强杀后再给一点时间收 exit 事件；还不来就不等了，
        // 真没退的话后面移目录会撞 EPERM，照常报 DIRECTORY_BUSY
        graceTimer = setTimeout(finish, FORCE_KILL_GRACE_MS);
      }, timeoutMs);
    });
  }

  /** 按 pid 杀单个并等它退出，用于"取消"动作 */
  async kill(pid: number, timeoutMs = 10_000): Promise<boolean> {
    const entry = this.entries.get(pid);
    if (!entry) return false;
    await this.terminate(pid, entry, timeoutMs);
    return true;
  }

  /**
   * 立刻连子孙一起强杀并等它退出（不先发 SIGTERM）。给 Agent 会话的兜底停止用：
   * Windows 上 SIGTERM 只结束父进程，它一退 terminate 就返回了，Bash 起的孙进程
   * 还攥着工作目录（Task 5.2 复审实测，scripts/spike-interrupt-cost.mjs）。
   */
  async killTree(pid: number, graceMs = FORCE_KILL_GRACE_MS): Promise<boolean> {
    const entry = this.entries.get(pid);
    if (!entry) return false;
    const { child } = entry;
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, graceMs);
      function done(): void {
        clearTimeout(timer);
        child.off("exit", done);
        resolve();
      }
      child.once("exit", done);
      forceKillTree(child, pid);
    });
    return true;
  }

  /**
   * 后端退出时收尸。必须连孙进程一起杀：渲染进程不会因为后端退出而自己停，
   * 只对直接子进程发 SIGTERM 会留下一堆孤儿接着吃 CPU 和显存
   * （DEV-PLAN Phase 13 验收要求「无孤儿子进程」）。
   *
   * 这里是同步的、不等退出：信号处理器里没有等待的余地，后端马上就要退了。
   */
  killAll(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const [pid, entry] of this.entries) {
      // Windows 上先连树杀，父进程还在时 taskkill /T 才枚举得到子孙（复审 S2-M1 实测）；
      // POSIX 上 SIGTERM 可捕获，先给一次体面退出的机会，再 SIGKILL
      if (process.platform !== "win32") entry.child.kill("SIGTERM");
      forceKillTree(entry.child, pid);
    }
    this.entries.clear();
  }
}

export const procs = new ProcRegistry();
