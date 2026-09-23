import type { AgentApi, AgentJobView, AgentMessageView, MessagePage } from "./agent.js";

/**
 * 抽屉的取数（server/src/routes/agent-jobs.ts 文件头，顺序要紧）：
 * 1. 先订阅 SSE（由 useAgentFeed 做），每次连上（含自动重连）调 `connected()`
 * 2. 还不知道任务 id：拉模板快照（最近一屏消息）；知道了：拉 `GET /api/agent-jobs/:id` 对 seq，
 *    落后就按 `afterSeq = 游标` 补齐——`agent-message` 不进重放缓冲，断线期间的消息没人会再通知
 * 3. 每条 `agent-message` 事件都走同一个补齐循环
 *
 * 游标只认 `nextSeq`：空页时它原样还回传进去的值，截短的页它停在页尾，所以照抄它既不倒退也不跳段。
 * `jobLastSeq` 只用来判断追平没有。往前翻的页（`beforeSeq`）只进显示，不碰游标。
 */
export interface FeedState {
  job: AgentJobView | null;
  /** 按 seq 升序、无重复 */
  messages: AgentMessageView[];
  /** 首屏是否已经拿到（没拿到之前显示骨架，不显示「没有任务」） */
  loaded: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  /** 最近一次取数失败的原文；下一次成功就清掉 */
  error: string | null;
  /** seq 大于它的消息是打开抽屉之后才到的：只有这些逐字流式，历史消息直接整段显示 */
  liveAfterSeq: number;
}

const EMPTY: FeedState = {
  job: null,
  messages: [],
  loaded: false,
  hasOlder: false,
  loadingOlder: false,
  error: null,
  liveAfterSeq: 0,
};

type Api = Pick<AgentApi, "templateJob" | "job" | "after" | "before">;

export class AgentFeed {
  private state: FeedState = EMPTY;
  private readonly listeners = new Set<() => void>();
  /** 往后拉的游标，只从 nextSeq 来 */
  private cursor = 0;
  /** 往前翻的起点：当前显示的最早一条 */
  private firstSeq = 0;
  /** 换任务（重跑出新任务）时加一：旧任务在路上的请求回来就扔掉 */
  private generation = 0;
  private syncing: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly templateId: string,
    private readonly api: Api,
  ) {}

  getState = (): FeedState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * 模板主题上、不属于任务与消息流的事件（复刻判据结论 `clone` 等）：由同一条 SSE 带进来，
   * 页面在这里订阅，不再各开一条连接（浏览器同主机 6 条连接的池子，两个标签页就能占满）
   */
  private readonly eventListeners = new Map<string, Set<(data: unknown) => void>>();

  onTemplateEvent(event: string, listener: (data: unknown) => void): () => void {
    const set = this.eventListeners.get(event) ?? new Set();
    set.add(listener);
    this.eventListeners.set(event, set);
    return () => {
      set.delete(listener);
    };
  }

  templateEvent(event: string, data: unknown): void {
    for (const listener of this.eventListeners.get(event) ?? []) listener(data);
  }

  get jobId(): string | null {
    return this.state.job?.id ?? null;
  }

  /** SSE 每次连上都调：第一次拉快照，之后对 seq 补齐 */
  connected(): Promise<void> {
    return this.sync();
  }

  /** `agent-message` 事件：只带 seq，按游标补齐 */
  messageArrived(jobId: string, seq: number): Promise<void> {
    if (jobId !== this.jobId || seq <= this.cursor) return Promise.resolve();
    return this.sync();
  }

  /**
   * `agent-job` 事件：同一个任务就换上新状态；更新的任务（重跑出来的）从头来。
   * 比当前任务还旧的那种事件（迟到的旧任务状态）不理：为它清空抽屉等于把看着的会话扔了。
   */
  jobChanged(view: AgentJobView): Promise<void> {
    if (view.ownerId !== this.templateId) return Promise.resolve();
    const current = this.state.job;
    if (view.id === current?.id) {
      this.set({ job: view });
      return Promise.resolve();
    }
    if (current && view.createdAt < current.createdAt) return Promise.resolve();
    this.reset();
    return this.sync();
  }

  /** 取数失败后人点「重试」：事件流可能一直安静（没在跑的任务不推事件），不能只等下一次事件 */
  retry(): Promise<void> {
    return this.sync();
  }

  /** 往上翻一页历史。只改显示，不动往后拉的游标 */
  async loadOlder(): Promise<void> {
    const jobId = this.jobId;
    if (!jobId || !this.state.hasOlder || this.state.loadingOlder) return;
    const gen = this.generation;
    this.set({ loadingOlder: true });
    try {
      const page = await this.api.before(jobId, this.firstSeq);
      if (gen !== this.generation) return;
      if (page.firstSeq > 0) this.firstSeq = page.firstSeq;
      this.set({ messages: merge(page.messages, this.state.messages), hasOlder: page.hasOlder, error: null });
    } catch (error) {
      if (gen === this.generation) this.set({ error: messageOf(error) });
    } finally {
      if (gen === this.generation) this.set({ loadingOlder: false });
    }
  }

  /** 换上中止等动作返回的任务状态 */
  replaceJob(view: AgentJobView): void {
    if (view.id === this.jobId) this.set({ job: view });
  }

  /**
   * 串行化的同步：同一时刻只有一轮在跑，跑的过程中又来了通知就在这一轮结束后再跑一轮。
   * 并发跑两轮会拿同一个游标各拉一页，合并时虽然去重，但游标会被较慢的那轮往回写。
   */
  private sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.again = false;
          await this.syncOnce();
        } while (this.again);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const gen = this.generation;
    try {
      if (!this.state.job) {
        await this.loadSnapshot(gen);
        return;
      }
      const head = await this.api.job(this.state.job.id);
      if (gen !== this.generation) return;
      this.set({ job: head.job, error: null });
      if (head.jobLastSeq > this.cursor) await this.catchUp(gen);
    } catch (error) {
      // 不标 loaded：快照没拿到时说不清「有没有任务」，界面给错误与重试，不给「还没有任务」
      if (gen === this.generation) this.set({ error: messageOf(error) });
    }
  }

  private async loadSnapshot(gen: number): Promise<void> {
    const snap = await this.api.templateJob(this.templateId);
    if (gen !== this.generation) return;
    this.cursor = snap.nextSeq;
    this.firstSeq = snap.firstSeq;
    this.set({
      job: snap.job,
      messages: snap.messages,
      hasOlder: snap.hasOlder,
      loaded: true,
      error: null,
      // 快照里的都是历史；之后到的才流式
      liveAfterSeq: snap.nextSeq,
    });
    if (snap.job && snap.hasNewer) await this.catchUp(gen);
  }

  /** 照抄 agent-jobs.ts 文件头那段循环 */
  private async catchUp(gen: number): Promise<void> {
    const jobId = this.jobId;
    if (!jobId) return;
    let page: MessagePage;
    do {
      page = await this.api.after(jobId, this.cursor);
      if (gen !== this.generation) return;
      this.cursor = page.nextSeq;
      if (this.firstSeq === 0 && page.firstSeq > 0) this.firstSeq = page.firstSeq;
      this.set({ messages: merge(this.state.messages, page.messages), error: null });
    } while (page.hasNewer);
  }

  private reset(): void {
    this.generation += 1;
    this.cursor = 0;
    this.firstSeq = 0;
    this.again = false;
    this.set({ ...EMPTY });
  }

  private set(patch: Partial<FeedState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** 按 seq 合并去重。先订阅再拉快照会重复拉到同一条，重复无害，这里吃掉 */
export function merge(a: readonly AgentMessageView[], b: readonly AgentMessageView[]): AgentMessageView[] {
  if (b.length === 0) return a as AgentMessageView[];
  const bySeq = new Map<number, AgentMessageView>();
  for (const m of a) bySeq.set(m.seq, m);
  for (const m of b) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
