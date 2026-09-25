import {
  createRuntimeEndpointAdapterFacet,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
  runtimeConfigString,
} from "@hypit/hypit/runtime-kit";
import { createCodexImageProvider, providerModule } from "./provider.js";

/**
 * Runtime Profile 里的配置（宿主按当前设置生成，REQ-011）：
 * `{ command, prefixArgs?, codexHome?, timeoutMs?, concurrency? }`，多一个键就拒——拼错的键静默失效
 * 比报错更难查。没有凭据：Codex 用它自己的登录（`$CODEX_HOME/auth.json`），Provider 不碰。
 */

const KEYS = ["command", "prefixArgs", "codexHome", "timeoutMs", "concurrency"];

function stringList(value: unknown, subject: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${subject} must be a list of non-empty strings`);
  }
  return value as string[];
}

export default {
  format: "hypit.node-package@1" as const,
  hostFacets: [
    createRuntimeEndpointAdapterFacet({
      use: providerModule.name,
      activate(context) {
        const config = runtimeConfigObject(context.config, "Codex image");
        runtimeConfigExact(config, KEYS, "Codex image");
        const command = runtimeConfigString(config.command, "Codex image command");
        if (!command) throw new Error("Codex image requires command");
        const prefixArgs = stringList(config.prefixArgs, "Codex image prefixArgs");
        const codexHome = runtimeConfigString(config.codexHome, "Codex image codexHome");
        const timeoutMs = runtimeConfigPositiveInteger(config.timeoutMs, "Codex image timeoutMs");
        const concurrency = runtimeConfigPositiveInteger(config.concurrency, "Codex image concurrency");
        return {
          endpoint: createCodexImageProvider({
            instance: context.instance,
            pool: context.pool ?? context.instance,
            command,
            ...(prefixArgs ? { prefixArgs } : {}),
            ...(codexHome ? { codexHome } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
            ...(concurrency ? { concurrency } : {}),
          }),
        };
      },
    }),
  ],
};
