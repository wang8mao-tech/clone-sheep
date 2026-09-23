import { defineConfig } from "vitest/config";

/**
 * 路由测试每个用例都 `vi.resetModules()` 后重新 import fastify 与整条服务端模块链：文件里第一个用例要付冷启动，
 * 平时一两秒。`pnpm run check` 让 server 与 web 两套测试并行跑，机器上还开着 dev server 时，冷启动能拖过
 * 默认的 5 秒，于是四个文件的第一个用例稳定超时、单独跑却全绿（Task 5.4 实测）。给足冷启动的余量；
 * 真卡死的用例照样会在 20 秒时失败，不会被这条盖住。
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});
