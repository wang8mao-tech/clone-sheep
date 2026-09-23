import { Breaker, systemClock, type Clock, type Verdict } from "./breaker.js";
import { createJob, requireJob, updateJob, type AgentJobRow, type NewJob, type OwnerKind } from "./job-store.js";
import { assertContinuable, assertLatest, assertOwnerFree, assertRerunnable } from "./job-guards.js";
import { runKind, settle, spendOf } from "./outcome.js";
import { planQuotaResume, type Spend } from "./quota.js";
import { continuePrompt } from "./prompts.js";
import type { RunOutcome } from "./runner.js";
import { SchedulerError, type Pending, type Running, type SchedulerDeps } from "./scheduler-types.js";
import { stopJob, stopOwnerJobs, type StopContext } from "./stop-job.js";

export { SchedulerError, type SchedulerDeps } from "./scheduler-types.js";
export { STOP_TIMEOUT_MS } from "./stop-job.js";

/**
 * Agent 任务调度（Spec REQ-003，DEV-PLAN Task 5.2）：并发上限、排队、取消、中止、继续、重跑，
 * 熔断与等待额度后的自动续跑。
 *
 * 队列只在内存里：后端重启时库里未结束的任务一律标「中断」（migrate.ts），由人点「继续」。
 * 每次由人发起的运行（开始 / 继续 / 重跑）拿满额的墙钟与花费；等待额度后的自动续跑属于
 * 同一次运行，只拿剩下的（maxBudgetUsd 只算本次 query() 起的花费，所以传剩余额度）。
 * 被宿主停下的运行也拿得到花费：runner 用 interrupt() 停，会收到带 total_cost_usd 的 result。
 *
 * 同一对象同一时刻只许一个未结束的任务，继续 / 重跑只许对它最新的任务做——两个 Agent
 * 同时写一个工作目录、或者 resume 一个产物已被重跑清掉的旧会话，都会写坏稿子。
 */
export class Scheduler {
  private readonly queue: Pending[] = [];
  private readonly running = new Map<string, Running>();
  private readonly waiting = new Map<string, unknown>();
  private readonly clock: Clock;

  constructor(private readonly deps: SchedulerDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** 新任务 */
  enqueue(input: NewJob): AgentJobRow {
    assertOwnerFree(input.ownerKind, input.ownerId);
    const job = createJob(input);
    this.deps.onChange?.(job);
    this.queue.push({ jobId: job.id, prompt: input.prompt, ...this.fullAllowance() });
    this.pump();
    return requireJob(job.id);
  }

  /**
   * 继续：resume 同一会话（熔断、中断、失败之后）。会话没起来的（重启时还在排队、刚开跑就被
   * 停）没有可 resume 的东西，也没写出任何产物：原样重发任务提示。
   */
  continueJob(jobId: string, customPrompt?: string): AgentJobRow {
    const prompt = customPrompt ?? continuePrompt();
    const job = requireJob(jobId);
    assertContinuable(job);
    assertLatest(job);
    assertOwnerFree(job.owner_kind, job.owner_id);
    let next: Pending;
    if (job.session_id) next = { jobId, prompt, resume: job.session_id, ...this.fullAllowance() };
    else if (customPrompt !== undefined) {
      // 打回意见这类话是说给原会话听的，会话没了就没有上下文可接：宁可报错也不能悄悄丢掉
      throw new SchedulerError("NO_SESSION", "这个任务的会话没起来，接不上你的意见，只能重跑");
    } else if (job.prompt) next = { jobId, prompt: job.prompt, ...this.fullAllowance() };
    else throw new SchedulerError("NO_SESSION", "这个任务的会话没起来，也没有保存任务提示，只能重跑");
    this.patch(jobId, { status: "queued", stop_reason: null, ended_at: null, resume_at: null });
    this.queue.push(next);
    this.pump();
    return requireJob(jobId);
  }

  /** 重跑：清掉 Agent 产物，按原任务提示开一个新任务（新会话）。先全部检查完再动文件 */
  rerun(jobId: string): AgentJobRow {
    const job = requireJob(jobId);
    assertRerunnable(job);
    assertLatest(job);
    assertOwnerFree(job.owner_kind, job.owner_id);
    this.deps.resetWorkspace(job);
    return this.enqueue({
      ownerKind: job.owner_kind,
      ownerId: job.owner_id,
      prompt: job.prompt,
      ...(job.model_id ? { modelId: job.model_id } : {}),
    });
  }

  /** 取消：排队中、等待额度、运行中都行，结果是「已取消」。运行中的等进程真正结束才返回 */
  cancel(jobId: string): Promise<AgentJobRow> {
    return this.stop(jobId, "cancel");
  }

  /** 中止（抽屉上的按钮）：停下来标「中断」，之后可以继续；从没跑起来过的等于取消 */
  abort(jobId: string): Promise<AgentJobRow> {
    return this.stop(jobId, "abort");
  }

  private stop(jobId: string, action: "cancel" | "abort"): Promise<AgentJobRow> {
    return stopJob(this.stopContext(), jobId, action);
  }

  /** 删对象前调用：停掉它所有没结束的任务，等进程都退出（AC-002）。返回停了几个 */
  stopOwner(ownerKind: OwnerKind, ownerId: string, action: "cancel" | "abort" = "abort"): Promise<number> {
    return stopOwnerJobs(ownerKind, ownerId, (jobId) => (action === "abort" ? this.abort(jobId) : this.cancel(jobId)));
  }

  private stopContext(): StopContext {
    return {
      running: this.running,
      queue: this.queue,
      waiting: this.waiting,
      clock: this.clock,
      patch: (jobId, patch) => this.patch(jobId, patch),
      pump: () => this.pump(),
    };
  }

  private fullAllowance(): Pick<Pending, "budgetUsd" | "wallMs" | "totalWallMs"> {
    const s = this.deps.settings();
    const wallMs = s.timeoutMinutes * 60_000;
    return { budgetUsd: s.budgetUsd, wallMs, totalWallMs: wallMs };
  }

  private pump(): void {
    const configured = Math.floor(this.deps.settings().concurrency);
    // 列里是垃圾值时 NaN 会让比较恒为 false，队列就永远不动了——退回默认 2
    const limit = Number.isFinite(configured) ? Math.max(1, configured) : 2;
    while (this.running.size < limit && this.queue.length > 0) {
      this.launch(this.queue.shift() as Pending);
    }
  }

  private launch(pending: Pending): void {
    // done 先放一个已完成的 Promise：execute 的同步前缀里会回调 onChange（用户代码），
    // 那一刻若有人来 stop，await 的必须是个真 Promise
    const entry: Running = { controller: new AbortController(), done: Promise.resolve() };
    this.running.set(pending.jobId, entry);
    entry.done = this.execute(pending, entry)
      .catch((error: unknown) => this.crashed(pending.jobId, error))
      .finally(() => {
        // 认这次运行本身，不认 jobId：被 stop 超时丢弃过的话，名额已经是新一轮运行的了
        if (!this.isCurrent(pending.jobId, entry)) return;
        this.running.delete(pending.jobId);
        this.pump();
      });
  }

  /** 调度器自己出错（库写不进去之类）：记日志，尽量把任务标失败，别让它在库里永远「运行中」 */
  private crashed(jobId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log?.error({ jobId, err: error }, "Agent 任务调度出错");
    try {
      this.patch(jobId, {
        status: "failed",
        stop_reason: `调度器内部错误：${message}`,
        ended_at: new Date().toISOString(),
      });
    } catch {
      // 库本身写不进去就只能等下次启动标「中断」了
    }
  }

  private async execute(pending: Pending, entry: Running): Promise<void> {
    const before = requireJob(pending.jobId);
    // 两列取同一个时刻、同一只时钟：分两次取会差出 1 毫秒，第一次开跑时 started_at 与 run_started_at 对不上
    const now = new Date(this.clock.now()).toISOString();
    // started_at 记任务第一次开始；run_started_at 记**这一段**的起点，run_elapsed_ms 记这次运行
    // 在此之前已经跑掉的时间。由人发起的运行（开始 / 继续 / 重跑）从 0 起算，等额度续跑接着算——
    // 这样「用时」在等额度、排队时自然冻住，也永远不会出现未来时间或负数（复审 S1-M1(r6)）
    const job = this.patch(pending.jobId, {
      status: "running",
      started_at: before.started_at ?? now,
      // 这一段的起点走注入的时钟：用时的另一半（run_elapsed_ms）也是它算出来的，
      // 两半必须同一个时间源，否则加起来就是两把尺子量出的数
      run_started_at: now,
      run_elapsed_ms: pending.elapsedMs ?? 0,
      ended_at: null,
      resume_at: null,
    });
    this.deps.onRunStart?.(job.id, { kind: runKind(pending, before.started_at), prompt: pending.prompt });
    let verdict: Verdict | undefined;
    let latestCost: number | undefined;
    // 本次运行之前已经记下的累计花费。resume 接上转录里的累计值时清零（那份累计里已经含它），
    // 新开会话（含 resume 却换了会话 id）时保留：那条会话的 total 从 0 起算，要叠上去
    let carry = pending.resume ? 0 : before.cost_usd;
    const breaker = new Breaker(
      { wallMs: pending.wallMs, totalWallMs: pending.totalWallMs },
      (v) => {
        verdict = v;
        entry.controller.abort();
      },
      this.clock,
    );
    let outcome: RunOutcome;
    try {
      outcome = await this.deps.run({
        workspace: this.deps.workspaceOf(job),
        prompt: pending.prompt,
        maxBudgetUsd: pending.budgetUsd,
        stopSignal: entry.controller.signal,
        subject: { kind: job.owner_kind, id: job.owner_id },
        ...(job.model_id ? { model: job.model_id } : {}),
        ...(pending.resume ? { resume: pending.resume } : {}),
        onIntercept: (denial) => {
          if (this.isCurrent(job.id, entry)) this.deps.onIntercept?.(job.id, denial);
        },
        onMessage: (message) => {
          breaker.observe(message);
          // 被丢弃的那次运行还会继续吐消息（它的进程没停干净）：不能拿它的会话 id、
          // 消息去盖新一轮的记录，否则「继续」会 resume 到一条过时的会话上
          if (!this.isCurrent(job.id, entry)) return;
          if (message.type === "system" && message.subtype === "init") {
            // 要 resume 却换来一个新会话 id：它的 total_cost_usd 从 0 起算，之前的花费得自己带着
            if (pending.resume && message.session_id !== pending.resume) carry = before.cost_usd;
            if (message.session_id !== job.session_id) this.patch(job.id, { session_id: message.session_id });
          }
          if (message.type === "result") {
            // 同一会话 resume 回来，累计值却比已记下的还小：转录里没保存累计值（SDK 注明这是有条件的），
            // 那这条会话的 total 是从 0 起算的，得把之前的花费带上。
            // 认了的边界：转录没接上、而这一段本身又比之前记下的还贵时，看起来就是正常的累计值，
            // 这一段之前的花费会被少记——花费本来就按「估」记账（Spec REQ-009）
            if (pending.resume && carry === 0 && message.total_cost_usd < before.cost_usd) carry = before.cost_usd;
            latestCost = message.total_cost_usd;
          }
          this.deps.onMessage?.(job.id, message);
        },
      });
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      breaker.stop();
    }
    const spend = spendOf(carry, latestCost, before.cost_usd, breaker.elapsedMs());
    // 已经被丢弃（stop 超时）：任务早标了失败，可能已经又跑起了新一轮，这里不能再写库
    if (!this.isCurrent(pending.jobId, entry)) return;
    const settlement = settle(outcome, verdict, entry.action);
    // 这一段跑完了：把它的时长并进累计值。之后不管是停下还是等额度，用时都不再往前走
    const ranMs = job.run_elapsed_ms + spend.elapsedMs;
    if (settlement.kind === "quota") {
      this.awaitQuota({ ...pending, elapsedMs: ranMs }, settlement.resumeAt, spend);
      return;
    }
    // 宿主自己停的（中止 / 取消、熔断）记一笔，抽屉认它判断「被停下」（复审 S1-N1）；限流的在 awaitQuota 里记
    if (entry.action || verdict) this.deps.onRunStop?.(job.id, { reason: settlement.stopReason ?? "" });
    this.patch(pending.jobId, {
      status: settlement.status,
      stop_reason: settlement.stopReason,
      cost_usd: spend.cost,
      run_elapsed_ms: ranMs,
      ended_at: new Date().toISOString(),
      resume_at: null,
    });
  }

  /** 订阅限流：进「等待额度」，到点用剩下的墙钟与花费自动续跑（算法在 quota.ts） */
  private awaitQuota(pending: Pending, resumeAt: Date, spend: Spend): void {
    const job = requireJob(pending.jobId);
    const plan = planQuotaResume(job, pending, spend);
    // 额度用光就不会续跑了：停下记录写真正的原因，别让抽屉说「等恢复后续跑」（复审 S1-R3-2）
    this.deps.onRunStop?.(job.id, { reason: plan.kind === "trip" ? plan.reason : "awaiting_quota" });
    if (plan.kind === "trip") {
      // 这里也是终态：额度用光不再续跑，这一段跑掉的时间同样要落库。少写这一笔，
      // 界面就会出现「原因：运行时间用完 / 用时 0 秒」这种自相矛盾的行（复审 S1-M1(r7)）
      const ended = { cost_usd: spend.cost, ended_at: new Date().toISOString() };
      const elapsed = pending.elapsedMs ?? job.run_elapsed_ms;
      this.patch(job.id, { status: "tripped", stop_reason: plan.reason, run_elapsed_ms: elapsed, ...ended });
      return;
    }
    const next = plan.next;
    // 等额度期间「用时」冻在已经跑掉的那些：累计值上一步已经并好，这里落库即可。
    // 不动 run_started_at——它只在运行中有意义，往前挪会虚高、往后挪会变成未来时间（复审 S1-M1(r6)）
    this.patch(job.id, {
      status: "awaiting_quota",
      cost_usd: spend.cost,
      run_elapsed_ms: next.elapsedMs ?? 0,
      resume_at: resumeAt.toISOString(),
    });
    const timer = this.clock.setTimeout(
      () => {
        this.waiting.delete(job.id);
        this.patch(job.id, { status: "queued", resume_at: null });
        this.queue.push(next);
        this.pump();
      },
      Math.max(0, resumeAt.getTime() - this.clock.now()),
    );
    this.waiting.set(job.id, timer);
  }

  /** 这次运行还是这个任务当前的那一次吗（stop 超时会丢弃一次运行，但它的进程还在吐消息） */
  private isCurrent(jobId: string, entry: Running): boolean {
    return this.running.get(jobId) === entry;
  }

  private patch(jobId: string, patch: Parameters<typeof updateJob>[1]): AgentJobRow {
    const job = updateJob(jobId, patch);
    this.deps.onChange?.(job);
    return job;
  }
}
