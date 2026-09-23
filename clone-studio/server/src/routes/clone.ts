import { open } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { present } from "../agent/agent-service.js";
import { latestJobOf } from "../agent/job-store.js";
import { ArchiveError, requireTemplate } from "../services/archive.js";
import { currentVerdict, latestReplica, startClone } from "../services/clone.js";
import { isReallyInside } from "../lib/safe-path.js";
import { archiveErrorHandler } from "./errors.js";

/** 给人看的文本上限。Agent 读的是磁盘上的全文，这里截断只影响页面 */
const TEXT_LIMIT = 256 * 1024;

interface CloneFile {
  text: string;
  /** 超过上限被截断了，页面要标出来 */
  truncated: boolean;
}

async function readCapped(dir: string, name: string): Promise<CloneFile | null> {
  const path = join(dir, name);
  // 文件是 Agent 写的：它要是把 ANALYSIS.md 做成指向工作目录外的链接，这里不跟过去（同 resetAgentProducts）
  if (existsSync(path) && !isReallyInside(dir, path)) return null;
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    // 没产生，或者刚好被重跑清掉（查存在和打开之间）：都当「还没有」
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(TEXT_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > TEXT_LIMIT;
    // 截断可能切在多字节字符中间，解码出的替换字符只会出现在末尾
    return { text: buffer.subarray(0, Math.min(bytesRead, TEXT_LIMIT)).toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}

export async function cloneRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(archiveErrorHandler);

  /**
   * ② 复刻页的数据：分析摘要、时间线、校验结果（SCREEN-004 三个区块），文件没产生就是 null，
   * 页面据此逐个显示区块。结论只给和当前这次运行对得上的那条，完成了还没核完是 verifying。
   * 另带当前的复刻片，估价卡从它接手。
   */
  app.get("/api/templates/:id/clone", async (request) => {
    const { id } = request.params as { id: string };
    const template = requireTemplate(id);
    const dir = template.workspace_path;
    const [analysis, timeline] = dir
      ? await Promise.all([readCapped(dir, "ANALYSIS.md"), readCapped(dir, "TIMELINE.md")])
      : [null, null];
    const replica = latestReplica(id);
    return {
      templateId: id,
      analysis,
      timeline,
      svrunExists: dir ? existsSync(join(dir, "reference.svrun")) : false,
      ...currentVerdict(id),
      replica: replica
        ? { id: replica.id, version: replica.version, status: replica.status, updatedAt: replica.updated_at }
        : null,
    };
  });

  /**
   * 手动开始复刻：自动启动上线前就导入完的模板没有任务（启动不补跑），给人一个入口。
   * 只在模板从没有过复刻任务时可用；有过的走横条上的「继续 / 重跑」，免得这里清掉一份做好的稿子。
   */
  app.post("/api/templates/:id/clone", async (request, reply) => {
    const { id } = request.params as { id: string };
    const template = requireTemplate(id);
    if (template.status !== "cloning") {
      throw new ArchiveError("模板还没到复刻这一步：先在 ① 参考 完成证据准备", "NOT_CLONING", 409);
    }
    const existing = latestJobOf("template", id);
    if (existing) {
      const message =
        existing.status === "done"
          ? "这个模板已经复刻完成了，不用再开始"
          : "这个模板已经有复刻任务了，用横条上的「继续」或「重跑」";
      throw new ArchiveError(message, "CLONE_EXISTS", 409);
    }
    let job;
    try {
      job = startClone(id);
    } catch (error) {
      // 工作目录缺 Runtime Profile 之类：清理前的自检拒绝了，原因原样给人
      throw new ArchiveError(
        `复刻任务没有起来：${error instanceof Error ? error.message : String(error)}`,
        "CLONE_NOT_STARTED",
        409,
      );
    }
    if (!job) throw new ArchiveError("复刻任务没有起来", "CLONE_NOT_STARTED", 409);
    return reply.code(201).send({ job: present(job) });
  });
}
