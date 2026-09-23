import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { JobNotFoundError } from "../agent/job-store.js";
import { SchedulerError } from "../agent/scheduler-types.js";
import { ArchiveError } from "../services/archive.js";
import { EvidenceError } from "../services/evidence.js";

/**
 * 归档接口的统一错误出口。
 * 业务错误按自己的状态码与 code 返回，界面靠 code 决定就地红字还是 toast；
 * zod 解析失败统一成 400 INVALID_BODY，与设置页的写法一致。
 */
export function archiveErrorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply): void {
  // 删除流程会先停 Agent 任务，停不下来时抛的是调度器的错：照它的状态码出去，不要变成 500
  if (error instanceof SchedulerError || error instanceof JobNotFoundError) {
    void reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ArchiveError || error instanceof EvidenceError) {
    void reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof z.ZodError) {
    void reply.status(400).send({
      error: { code: "INVALID_BODY", message: "请求参数不合法", detail: error.issues },
    });
    return;
  }
  void reply.status(error.statusCode ?? 500).send({
    error: { code: error.code ?? "INTERNAL", message: error.message },
  });
}
