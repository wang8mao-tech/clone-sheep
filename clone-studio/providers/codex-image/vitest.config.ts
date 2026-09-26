import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** 与 tsconfig 的 paths 同一份映射：公开 SDK 子路径与测试用的 driver / 模型包指到 hypit-main 源码（只读） */
const hypit = (rel: string) => fileURLToPath(new URL(`../../../hypit-main/packages/${rel}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@hypit/hypit/endpoint-kit": hypit("endpoint-kit/src/index.ts"),
      "@hypit/hypit/generation": hypit("generation/src/index.ts"),
      "@hypit/hypit/runtime-kit": hypit("runtime-kit/src/index.ts"),
      "@hypit/driver-node": hypit("driver-node/src/index.ts"),
      "@hypit/gpt-image": hypit("gpt-image/src/index.ts"),
    },
  },
  test: {
    // 假 codex 是真起的子进程：机器忙时冷启动慢，给足余量；真卡死照样 20 秒失败
    testTimeout: 20_000,
  },
});
