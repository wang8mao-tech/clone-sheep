import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const PROFILE_FILENAME = "hypit.runtime.json";

/**
 * 工作目录里必须存在的子目录。新建与存量迁移共用这一份清单——
 * 两边各写一份迟早会漂，而漂出来的差异只在存量模板上炸。
 */
const WORKSPACE_DIRS = [["productions"], ["assets"], ["references", "src"]] as const;

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
 * 建目录、写文件、并把 Runtime Profile **选中**。目录布局按 Spec 6.3：
 * <data>/clients/<clientId>/templates/<templateId>/
 *
 * 选中这一步不能省：hypit 只从该项目的 `.hypit/runtime` 读选择，既不按文件名
 * 发现 `hypit.runtime.json`，也不继承父目录。只写 profile 不选中的话，
 * `transcribe` 一律报「No Runtime Profile is selected」——Phase 2 就是这么漏的。
 *
 */
export function createWorkspace(args: CreateWorkspaceArgs): CreatedWorkspace {
  const dir = workspaceDir(args.clientId, args.templateId);
  // 已经存在就不是"本次新建"，出错时不能删——那会连别人的数据一起删掉
  const preexisting = existsSync(dir);
  mkdirSync(dir, { recursive: true });

  try {
    return writeWorkspaceFiles(dir, args);
  } catch (error) {
    // 半成品目录比没有更糟：它跑不了任何 hypit 命令，还占着这个 templateId
    if (!preexisting) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function writeWorkspaceFiles(dir: string, args: CreateWorkspaceArgs): CreatedWorkspace {
  const pkg = {
    name: `clone-studio-${sanitizeName(args.slug)}`,
    version: "0.0.0",
    private: true,
    type: "module",
    description: "Clone Studio 生成的 Hypit 工程目录，勿手工改动",
  };
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const profilePath = path.join(dir, PROFILE_FILENAME);
  writeFileSync(profilePath, `${JSON.stringify(buildRuntimeProfile(args.services), null, 2)}\n`, "utf8");

  ensureWorkspaceLayout(dir);

  return { dir, profilePath };
}

/** hypit 记录选择的地方。内容是 profile 文件名，相对该项目目录。 */
function selectionFile(dir: string): string {
  return path.join(dir, ".hypit", "runtime");
}

/**
 * 把一个工作目录补成「hypit 能跑、Clone Studio 能往里写」的完整形态。
 *
 * 幂等，且兼作存量模板的迁移入口：Phase 2 建出来的目录既没有 `.hypit/runtime`，
 * 也没有 `references/src`。两件事必须一起补——只补选中的话，存量模板在
 * Phase 4 落盘 `references/src/source.mp4` 时会 ENOENT，而新建模板一切正常，
 * 开发期用新模板自测百分百测不出来。
 *
 * 保证：目录布局与 Runtime Profile 选择，调用后一定都在。
 */
export function ensureWorkspaceLayout(dir: string): void {
  if (!existsSync(path.join(dir, PROFILE_FILENAME))) {
    throw new Error(`工作目录缺少 ${PROFILE_FILENAME}：${dir}`);
  }
  for (const rel of WORKSPACE_DIRS) mkdirSync(path.join(dir, ...rel), { recursive: true });
  ensureRuntimeSelected(dir);
}

/**
 * 确保这个工作目录选中了自己的 Runtime Profile。
 *
 * **为什么自己写文件而不是 spawn `hypit runtime use`**：这个契约是
 * `hypit runtime --help` 明写的——「Selection is read only from that project's
 * `.hypit/runtime`」，实测 `runtime use` 也只写两个文件：`.hypit/runtime` =
 * profile 文件名、`.hypit/.gitignore` = `*`，与这里的产出逐字节相同。
 * 而每次 spawn 要 2 秒，建模板是同步路径、单测里要跑二十多次，代价是把
 * 1.8 秒的套件拖成四十多秒，还让单测依赖 hypit 二进制在不在。
 *
 * 代价是 hypit 改了这个格式时这里会失效。**这条由 workspace.contract.test.ts
 * 钉住**：它用真 hypit 的 `doctor` 验我们写的选择还认不认，让失效变成一条红的
 * 测试，而不是用户导入视频那一刻的故障单。
 */
export function ensureRuntimeSelected(dir: string): void {
  // 已经选中就原样退出。不短路的话，启动迁移会在每次后端启动时给每个模板重写
  // 两个文件；将来挂到 transcribe 前面就是热路径上的重复写盘
  if (readSelection(dir) === PROFILE_FILENAME) return;

  const hypitDir = path.join(dir, ".hypit");
  mkdirSync(hypitDir, { recursive: true });
  // 这一份是 hypit 自己建的：执行状态目录不该进任何版本库
  writeFileSync(path.join(hypitDir, ".gitignore"), "*\n", "utf8");
  writeFileSync(selectionFile(dir), `${PROFILE_FILENAME}\n`, "utf8");
}

function readSelection(dir: string): string | undefined {
  const file = selectionFile(dir);
  if (!existsSync(file)) return undefined;
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    // 读不出来当作没选中，下一步会重写
    return undefined;
  }
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
