import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentScheduler, present } from "../agent/agent-service.js";
import { latestJobOf, requireJob } from "../agent/job-store.js";
import { lastSeq, listMessages, listMessagesBefore, listRecentMessages, PAGE_LIMIT } from "../agent/message-store.js";
import { requireTemplate } from "../services/archive.js";
import { readProduction } from "../services/build-store.js";
import { EvidenceError } from "../services/evidence-types.js";
import { ownerGate } from "../services/owner-gate.js";
import { rerunVariant } from "../services/variant-review.js";
import { assertLatest } from "../agent/job-guards.js";
import { continuePromptFor } from "../services/clone.js";
import { pendingRework } from "../services/review.js";
import { archiveErrorHandler } from "./errors.js";

/**
 * Agent 任务的读取与控制（Spec REQ-003）。抽屉的取数顺序（顺序要紧）：
 * 1. **先**订阅 SSE：模板主题拿状态，`job:<id>` 拿消息通知
 * 2. **再** `GET /api/templates/:id/agent-job` 拿任务与最近一屏消息（刷新后靠它恢复，AC-009）
 * 3. 之后每收到一条 `agent-message` 就按 `afterSeq=<游标>` 拉增量，`hasNewer` 为真接着拉；
 *    往上滚看历史用 `beforeSeq=<本页 firstSeq>`，`hasOlder` 为真还能再往前
 * 4. 中止 / 继续 / 重跑走下面的 POST
 *
 * 往后拉的游标只有一条规则，照抄即可：
 *
 * ```
 * let cursor = snapshot.nextSeq;                    // 快照那一页给的游标
 * let page;
 * do {
 *   page = await get(`/messages?afterSeq=${cursor}`);
 *   append(page.messages);
 *   cursor = page.nextSeq;                          // 空页时它等于你传进去的 cursor
 * } while (page.hasNewer);
 * ```
 *
 * 别用 `jobLastSeq` 当游标：一页可能因为条数或字节上限被截短，跳到库里最后一条就把中间
 * 那些永远漏掉了（复审 S1-M7）。`jobLastSeq` 只用来判断「追平了没有」。
 * 往前翻拿到的页只用于显示，不要动这个游标。
 *
 * **每次连上都要重对一次**，不只是第一次：`EventSource` 断线会自动重连，而 `agent-message`
 * 事件不进重放缓冲（它能按 seq 补，占缓冲反而挤掉别的主题），所以重连之后不会有人告诉你
 * 断线期间发生过什么。每次 `open` 都重新拉一次 `GET /api/agent-jobs/:jobId`（它给 jobLastSeq）
 * 再按上面那段循环补齐，断 20 秒也不会让抽屉永远少一段。
 *
 * 反过来「先拉快照再订阅」会漏掉这两步之间产生的消息——事件只带 seq 不带消息体，
 * 漏掉的那条要等下一条消息来了才顺带补上；如果它正好是本次运行的最后一条（通常是 result），
 * 抽屉就会一直少一条。先订阅则最多重复拉一次，重复是无害的。
 *
 * 事件里只带 seq 不带消息体：刷新、断线重连、正常流式三条路都收敛到「按 seq 拉」，
 * 少一条只在内存里的真相来源。
 */
/** 首屏可以少要几条：长会话一开抽屉不必先等满满一页（复审 S1-L5） */
const SnapshotQuery = z.object({ limit: z.coerce.number().int().min(1).max(PAGE_LIMIT).default(PAGE_LIMIT) });

const MessagesQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  /** 往前翻：这一条之前的一页 */
  // 允许 0：空页的 firstSeq 就是 0，前端照着往前翻不该吃一个 400（复审 S1-L3）
  beforeSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT).default(PAGE_LIMIT),
});

export async function agentJobRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(archiveErrorHandler);

  /** 某个对象当前的 Agent 任务（没有就 null），带最近一屏消息 */
  function snapshot(ownerKind: "template" | "production", ownerId: string, query: unknown) {
    const job = latestJobOf(ownerKind, ownerId);
    const { limit } = SnapshotQuery.parse(query);
    if (!job) {
      return {
        job: null,
        messages: [],
        hasOlder: false,
        hasNewer: false,
        firstSeq: 0,
        lastSeq: 0,
        nextSeq: 0,
        jobLastSeq: 0,
      };
    }
    return { job: present(job), ...listRecentMessages(job.id, limit) };
  }

  app.get("/api/templates/:id/agent-job", (request) => {
    const { id } = request.params as { id: string };
    requireTemplate(id);
    return snapshot("template", id, request.query);
  });

  /** 出片单位（变体）当前的 Agent 任务：抽屉跟随所选变体（Design-Brief §2.3「在 007 显示该变体的任务」，Task 9.3） */
  app.get("/api/productions/:id/agent-job", (request) => {
    const { id } = request.params as { id: string };
    if (!readProduction(id)) throw new EvidenceError("PRODUCTION_NOT_FOUND", "出片单位不存在。", 404);
    return { ...snapshot("production", id, request.query), owner: ownerGate(id) };
  });

  app.get("/api/agent-jobs/:jobId", (request) => {
    const { jobId } = request.params as { jobId: string };
    // 名字和分页里的 jobLastSeq 一致：游标推进只认这一个含义（复审 S1-M4）
    const job = requireJob(jobId);
    // 出片单位的任务带上这条出片单位此刻能做什么（它的状态会在任务之外变：作废、交给出片）
    const owner = job.owner_kind === "production" ? { owner: ownerGate(job.owner_id) } : {};
    return { job: present(job), jobLastSeq: lastSeq(jobId), ...owner };
  });

  /**
   * 消息分页。往后拉增量用 `afterSeq`（SSE 给的 seq），往前翻历史用 `beforeSeq`。
   * 返回里 `hasNewer` / `hasOlder` 分别说明两个方向还有没有。
   */
  app.get("/api/agent-jobs/:jobId/messages", (request) => {
    const { jobId } = request.params as { jobId: string };
    requireJob(jobId);
    const { afterSeq, beforeSeq, limit } = MessagesQuery.parse(request.query);
    return beforeSeq === undefined ? listMessages(jobId, afterSeq, limit) : listMessagesBefore(jobId, beforeSeq, limit);
  });

  /** 中止：停下来标「中断」，之后可以继续 */
  app.post("/api/agent-jobs/:jobId/abort", async (request) => {
    const { jobId } = request.params as { jobId: string };
    return { job: present(await agentScheduler().abort(jobId)) };
  });

  /**
   * 继续：resume 同一会话。带 note 时把它原样交给会话（验货打回走自己的 /api/templates/:id/rework，不走这里）。
   * 打回意见排了队还没交出去（排队中被中止 / 后端重启）：接着交那条意见，这一轮仍记成 rework
   */
  app.post("/api/agent-jobs/:jobId/continue", (request) => {
    const { jobId } = request.params as { jobId: string };
    const { note } = z.object({ note: z.string().min(1).max(2_000).optional() }).parse(request.body ?? {});
    // 复刻判据没过之后的继续：把没过的原因交给会话，而不是一句通用的「接着做」（Task 6.1 S2-M3）
    const rework = note === undefined ? pendingRework(jobId) : undefined;
    if (rework) return { job: present(agentScheduler().continueJob(jobId, rework, "rework")) };
    return { job: present(agentScheduler().continueJob(jobId, note ?? continuePromptFor(jobId))) };
  });

  /**
   * 重跑：清掉 Agent 产物，按原任务提示重开一个任务。
   * 变体的任务走 ④ 的重跑（rerunVariant）：除了清文件还要清素材行、运行文件、把变体放回排队，
   * 只走调度器的重跑会留下旧素材与旧运行文件（Task 9.3：007 上的 CMP-009 横条也用这个接口）
   */
  app.post("/api/agent-jobs/:jobId/rerun", (request) => {
    const { jobId } = request.params as { jobId: string };
    // 重跑可重选档案（REQ-010、CMP-009 的确认框里放 CMP-010）；不给用原档案
    const { profileId } = z.object({ profileId: z.string().min(1).optional() }).parse(request.body ?? {});
    const job = requireJob(jobId);
    if (job.owner_kind === "production") {
      // 同调度器的重跑：只认最新的那个任务（别的标签页里看着的旧任务不能拿来重跑）
      assertLatest(job);
      rerunVariant(job.owner_id, profileId);
      const next = latestJobOf("production", job.owner_id);
      if (!next) throw new EvidenceError("JOB_NOT_FOUND", "重跑之后没有找到新任务", 500);
      return { job: present(next) };
    }
    return { job: present(agentScheduler().rerun(jobId, profileId)) };
  });
}
