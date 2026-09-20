import Fastify from "fastify";
import { config } from "./config.js";
import { markStaleRunningAsInterrupted, migrate } from "./db/migrate.js";
import { procs } from "./lib/procs.js";
import { purgeTrash } from "./services/deletion.js";
import { migrateWorkspaces } from "./services/workspace-migration.js";
import { clientRoutes } from "./routes/clients.js";
import { settingsRoutes } from "./routes/settings.js";
import { systemRoutes } from "./routes/system.js";
import { referenceRoutes } from "./routes/reference.js";
import { templateRoutes } from "./routes/templates.js";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
  },
  // SSE 长连接不能被请求超时掐断
  connectionTimeout: 0,
  requestTimeout: 0,
});

async function main(): Promise<void> {
  migrate();
  const purged = purgeTrash();
  if (purged) app.log.info({ purged }, "清掉了上次删除残留在 .trash 的目录");

  // Phase 2 建的工作目录缺 Runtime Profile 选中与 references/src，补齐存量
  const workspaces = migrateWorkspaces();
  if (workspaces.repaired) {
    app.log.info({ repaired: workspaces.repaired }, "补齐了存量模板的工作目录");
  }
  for (const failure of workspaces.failures) {
    app.log.warn(failure, "模板的工作目录补不齐，该模板暂时无法导入参考视频");
  }

  const stale = markStaleRunningAsInterrupted();
  if (stale.jobs || stale.productions || stale.builds) {
    app.log.warn({ stale }, "上次退出时有未完成的任务，已标为中断");
  }

  await app.register(systemRoutes);
  await app.register(settingsRoutes);
  await app.register(clientRoutes);
  await app.register(templateRoutes);
  await app.register(referenceRoutes);

  // 只绑回环地址：单机单用户，不做权限模型，也就绝不能对外暴露（Spec 6.3 / 非功能需求）
  await app.listen({ host: config.host, port: config.port });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // 先收子进程的尸：渲染进程不会因为后端退出而自己停
    procs.killAll();
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

main().catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
