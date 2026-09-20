import Fastify from "fastify";
import { config } from "./config.js";
import { markStaleRunningAsInterrupted, migrate } from "./db/migrate.js";
import { systemRoutes } from "./routes/system.js";

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
  const stale = markStaleRunningAsInterrupted();
  if (stale.jobs || stale.productions || stale.builds) {
    app.log.warn(
      { stale },
      "上次退出时有未完成的任务，已标为中断",
    );
  }

  await app.register(systemRoutes);

  // 只绑回环地址：单机单用户，不做权限模型，也就绝不能对外暴露（Spec 6.3 / 非功能需求）
  await app.listen({ host: config.host, port: config.port });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
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
