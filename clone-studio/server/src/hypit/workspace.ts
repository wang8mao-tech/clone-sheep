import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * 模板工程目录生成器。
 *
 * 生成的目录是一个能被 `hypit doctor --workspace <dir> --json` 识别的 Hypit 工程：
 * 最小 package.json + hypit.runtime.json。
 *
 * 下面所有能力键都取自 hypit-main 源码里的 manifest，不是猜的：
 * - `@hypit/media-pipeline@1#*`      packages/media-pipeline/src/manifest.ts
 * - `@hypit/render-hyperframes@1#*`  packages/provider-hyperframes-local
 * - `@hypit/whisperx@1#*`            packages/whisperx/src/manifest.ts
 * - TokenDance 的 seedance/seedream/minimax-h3  packages/provider-tokendance/README.md
 */

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
    endpoints["whisperx.local"] = { use: "@hypit/provider-whisperx-local", config: {} };
    for (const cap of WHISPERX_CAPABILITIES) bindings[cap] = "whisperx.local";
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

  return {
    format: "hypit.runtime-local@1",
    dataRoot: ".hypit/execution",
    credentials: { env: { use: "@hypit/credential-store-env" } },
    endpoints,
    bindings,
  };
}

export interface CreateWorkspaceArgs {
  clientId: string;
  templateId: string;
  /** 只用于 package.json 的 name，不参与路径 */
  slug: string;
  services: WorkspaceServices;
}

export interface CreatedWorkspace {
  dir: string;
  profilePath: string;
}

/**
 * 建目录并写两个文件。目录布局按 Spec 6.3：
 * <data>/clients/<clientId>/templates/<templateId>/
 */
export function createWorkspace(args: CreateWorkspaceArgs): CreatedWorkspace {
  const dir = workspaceDir(args.clientId, args.templateId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(dir, "productions"), { recursive: true });
  mkdirSync(path.join(dir, "assets"), { recursive: true });

  const pkg = {
    name: `clone-studio-${sanitizeName(args.slug)}`,
    version: "0.0.0",
    private: true,
    type: "module",
    description: "Clone Studio 生成的 Hypit 工程目录，勿手工改动",
  };
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const profilePath = path.join(dir, "hypit.runtime.json");
  writeFileSync(profilePath, `${JSON.stringify(buildRuntimeProfile(args.services), null, 2)}\n`, "utf8");

  return { dir, profilePath };
}

export function workspaceDir(clientId: string, templateId: string): string {
  return path.join(config.dataRoot, "clients", clientId, "templates", templateId);
}

/** npm 包名只允许小写字母、数字和 -._，这里把别的都换成 - */
function sanitizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return cleaned || "template";
}
