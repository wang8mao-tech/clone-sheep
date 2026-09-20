import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

/**
 * 组件测试跑在 jsdom 里。
 *
 * 单独一个配置文件而不是塞进 vite.config：跑测试不需要 dev server 的代理和端口，
 * 混在一起以后改任何一边都要当心碰到另一边。
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: false,
      setupFiles: ["./src/test/setup.ts"],
      restoreMocks: true,
      // restoreMocks 只管 vi.spyOn 建的 spy，撤不掉 vi.stubGlobal。
      // 不加这条，某条用例忘了装 fetch 桩会安静地复用上一条的桩跑绿，
      // 而不是按 harness 的设计抛「没有给 … 准备桩」
      unstubGlobals: true,
    },
  }),
);
