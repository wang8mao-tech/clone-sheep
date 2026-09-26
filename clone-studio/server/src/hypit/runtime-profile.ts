import { WHISPERX_ENDPOINT_ID } from "./whisperx-service.js";

/**
 * 模板工程的 Runtime Profile（hypit.runtime.json）：写哪些 endpoint、能力绑到谁。
 *
 * 下面所有能力键都取自 hypit-main 源码里的 manifest，不是猜的：
 * - `@hypit/media-pipeline@1#*`      packages/media-pipeline/src/manifest.ts
 * - `@hypit/render-hyperframes@1#*`  packages/provider-hyperframes-local
 * - `@hypit/whisperx@1#*`            packages/whisperx/src/manifest.ts
 * - TokenDance 的 seedance/seedream/minimax-h3  packages/provider-tokendance/README.md
 * - `@hypit/gpt-image@1#gpt-image-2` packages/gpt-image/src/index.ts（Codex 订阅生图，REQ-011）
 */

/** Codex 订阅生图（REQ-011）：宿主同步到数据根 node_modules 的项目自有 Provider 包 */
export const CODEX_PACKAGE = "@clone-studio/codex-image";
export const CODEX_ENDPOINT_ID = "codex.local";
export const CODEX_CAPABILITIES = ["@hypit/gpt-image@1#gpt-image-2"] as const;

/** 起 codex 的方式（`.cmd` 垫片已解析成 node + codex.js）与它的 CODEX_HOME */
export interface CodexEndpoint {
  command: string;
  prefixArgs: readonly string[];
  /** 宿主进程设了 CODEX_HOME 才写；不写就是 Provider 的默认 ~/.codex */
  codexHome?: string;
}

/** 本地 Provider 承接的能力，全部零价 */
const MEDIA_LOCAL_CAPABILITIES = [
  "@hypit/media-pipeline@1#inspect-media",
  "@hypit/media-pipeline@1#normalize-media",
  "@hypit/media-pipeline@1#transform-media",
  "@hypit/media-pipeline@1#extract-media-audio",
  "@hypit/media-pipeline@1#extract-media-frame",
  "@hypit/media-pipeline@1#render-still-video",
  "@hypit/media-pipeline@1#project-speech-evidence-audio",
  "@hypit/media-pipeline@1#render-timeline-audio",
  "@hypit/media-pipeline@1#mux-program-media",
] as const;

const HYPERFRAMES_CAPABILITIES = ["@hypit/render-hyperframes@1#render-visual"] as const;

const WHISPERX_CAPABILITIES = ["@hypit/whisperx@1#whisperx-alignment"] as const;

/** TokenDance 覆盖的能力（README 的对照表） */
const TOKENDANCE_CAPABILITIES = [
  "@hypit/seedance@1#seedance-2",
  "@hypit/seedance@1#seedance-2-fast",
  "@hypit/seedance@1#seedance-2-mini",
  "@hypit/seedance@1#seedance-2.5",
  "@hypit/seedream@1#seedream-5-lite",
  "@hypit/minimax-h3@1#minimax-h3",
] as const;

export interface WorkspaceServices {
  /** TokenDance key 已验证时才写它的 endpoint，否则 plan 会在用到时明确报缺能力 */
  tokendance: boolean;
  hypihub: boolean;
  whisperx: boolean;
  /** 渲染并发 */
  renderWorkers: number;
  renderConcurrency: number;
  /** 启用且体检通过时才写 codex.local 并把 gpt-image 绑过去；否则 gpt-image 走别的通道或报缺能力 */
  codex?: CodexEndpoint | null;
}

export interface RuntimeProfile {
  format: "hypit.runtime-local@1";
  dataRoot: string;
  credentials: Record<string, { use: string }>;
  endpoints: Record<string, { use: string; pool?: string; config?: Record<string, unknown> }>;
  bindings: Record<string, string>;
}

export function buildRuntimeProfile(services: WorkspaceServices): RuntimeProfile {
  const endpoints: RuntimeProfile["endpoints"] = {
    "media.local": {
      use: "@hypit/provider-media-local",
      config: { defaultConcurrency: 2 },
    },
    "hyperframes.local": {
      use: "@hypit/provider-hyperframes-local",
      pool: "local-render",
      config: {
        workers: services.renderWorkers,
        defaultConcurrency: services.renderConcurrency,
        quality: "standard",
      },
    },
  };

  const bindings: RuntimeProfile["bindings"] = {};
  for (const cap of MEDIA_LOCAL_CAPABILITIES) bindings[cap] = "media.local";
  for (const cap of HYPERFRAMES_CAPABILITIES) bindings[cap] = "hyperframes.local";

  if (services.whisperx) {
    // config 留空 = provider 默认地址 127.0.0.1:8765；体检与转写前的拉起都依赖这一点
    endpoints[WHISPERX_ENDPOINT_ID] = { use: "@hypit/provider-whisperx-local", config: {} };
    for (const cap of WHISPERX_CAPABILITIES) bindings[cap] = WHISPERX_ENDPOINT_ID;
  }

  if (services.tokendance) {
    endpoints["tokendance.default"] = {
      use: "@hypit/provider-tokendance",
      // TokenDance Provider 强制要求 pool（activation.ts 会抛 "Pool is required"）
      pool: "tokendance.default",
      config: {
        // 凭据走环境变量，明文绝不落进工作目录（Spec REQ-006）
        apiKey: { store: "env", key: "TOKENDANCE_API_KEY" },
        defaultConcurrency: 2,
      },
    };
    for (const cap of TOKENDANCE_CAPABILITIES) bindings[cap] = "tokendance.default";
  }

  if (services.hypihub) {
    endpoints["hypihub.default"] = {
      use: "@hypit/provider-hypihub",
      pool: "hypihub.default",
      config: {
        baseUrl: "https://hypit.ai",
        apiKey: { store: "env", key: "HYPIHUB_TOKEN" },
        defaultConcurrency: 4,
      },
    };
    // HypiHub 覆盖的能力清单由它自己的 README 定义，这里不硬编码猜测：
    // 未绑定的能力在 plan 时会明确报"无 Provider 可解析"，比绑错强。
  }

  if (services.codex) {
    endpoints[CODEX_ENDPOINT_ID] = {
      use: CODEX_PACKAGE,
      pool: CODEX_ENDPOINT_ID,
      config: {
        command: services.codex.command,
        prefixArgs: [...services.codex.prefixArgs],
        ...(services.codex.codexHome ? { codexHome: services.codex.codexHome } : {}),
        // 订阅额度约 40-50 张 / 3 小时滚动窗口：一次只出一张（REQ-011 SHOULD）
        concurrency: 1,
      },
    };
    for (const cap of CODEX_CAPABILITIES) bindings[cap] = CODEX_ENDPOINT_ID;
  }

  return {
    format: "hypit.runtime-local@1",
    dataRoot: ".hypit/execution",
    credentials: { env: { use: "@hypit/credential-store-env" } },
    endpoints,
    bindings,
  };
}
