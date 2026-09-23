import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentScheduler, present } from "../agent/agent-service.js";
import { latestJobOf, requireJob } from "../agent/job-store.js";
import { lastSeq, listMessages, listMessagesBefore, listRecentMessages, PAGE_LIMIT } from "../agent/message-store.js";
import { requireTemplate } from "../services/archive.js";
import { archiveErrorHandler } from "./errors.js";

/**
 * Agent 任务的读取与控制（Spec REQ-003）。抽屉的取数顺序（顺序要紧）：
 * 1. **先**订阅 SSE：模板主题拿状态，`job:<id>` 拿消息通知
 * 2. **再** `GET /api/templates/:id/agent-job` 拿任务与最近一屏消息（刷新后靠它恢复，AC-009）
 * 3. 之后每收到一条 `agent-message` 就按它的 seq 拉增量；`hasMore` 为真接着拉
 * 4. 中止 / 继续 / 重跑走下面的 POST
 *
 * **每次连上都要重对一次**，不只是第一次：`EventSource` 断线会自动重连，而 `agent-message`
 * 事件不进重放缓冲（它能按 seq 补，占缓冲反而挤掉别的主题），所以重连之后不会有人告诉你
 * 断线期间发生过什么。每次 `open` 都重新拉一次 `GET /api/agent-jobs/:jobId`（带 lastSeq）
 * 再按 seq 补齐，断 20 秒也不会让抽屉永远少一段。
 *
 * 反过来「先拉快照再订阅」会漏掉这两步之间产生的消息——事件只带 seq 不带消息体，
 * 漏掉的那条要等下一条消息来了才顺带补上；如果它正好是本次运行的最后一条（通常是 result），
 * 抽屉就会一直少一条。先订阅则最多重复拉一次，重复是无害的。
 *
 * 事件里只带 seq 不带消息体：刷新、断线重连、正常流式三条路都收敛到「按 seq 拉」，
 * 少一条只在内存里的真相来源。
 */
const MessagesQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  /** 往前翻：这一条之前的一页 */
  beforeSeq: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT).default(PAGE_LIMIT),
});

export async function agentJobRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(archiveErrorHandler);

  /** 模板当前的 Agent 任务（没有就 null），带最近一屏消息 */
  app.get("/api/templates/:id/agent-job", (request) => {
    const { id } = request.params as { id: string };
    requireTemplate(id);
    const job = latestJobOf("template", id);
    if (!job) return { job: null, messages: [], hasOlder: false, hasNewer: false, firstSeq: 0, lastSeq: 0 };
    return { job: present(job), ...listRecentMessages(job.id) };
  });

  app.get("/api/agent-jobs/:jobId", (request) => {
    const { jobId } = request.params as { jobId: string };
    return { job: present(requireJob(jobId)), lastSeq: lastSeq(jobId) };
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

  /** 取消：结果是「已取消」 */
  app.post("/api/agent-jobs/:jobId/cancel", async (request) => {
    const { jobId } = request.params as { jobId: string };
    return { job: present(await agentScheduler().cancel(jobId)) };
  });

  /** 继续：resume 同一会话；带 note 时把它当作说给 Agent 的话（验货打回，Phase 7 用） */
  app.post("/api/agent-jobs/:jobId/continue", (request) => {
    const { jobId } = request.params as { jobId: string };
    const { note } = z.object({ note: z.string().min(1).max(2_000).optional() }).parse(request.body ?? {});
    return { job: present(agentScheduler().continueJob(jobId, note)) };
  });

  /** 重跑：清掉 Agent 产物，按原任务提示重开一个任务 */
  app.post("/api/agent-jobs/:jobId/rerun", (request) => {
    const { jobId } = request.params as { jobId: string };
    return { job: present(agentScheduler().rerun(jobId)) };
  });
}
