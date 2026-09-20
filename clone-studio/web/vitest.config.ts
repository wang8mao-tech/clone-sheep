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
      // 纯逻辑用例跑在 node 环境更快，也免得它们被 jsdom 的缺省实现带偏
      environmentMatchGlobs: [["src/lib/**", "node"]],
      restoreMocks: true,
    },
  }),
);
