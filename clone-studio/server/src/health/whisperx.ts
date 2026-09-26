import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  PORT_TAKEN_MESSAGE,
  probeWhisperX,
  WHISPERX_ENDPOINT_ID,
  WHISPERX_HOST,
  WHISPERX_PORT,
  WHISPERX_PROGRAM_DIR,
  type WhisperXProbe,
} from "../hypit/whisperx-service.js";
import type { CheckResult } from "./checks.js";

/**
 * 本地 WhisperX 转写（REQ-002 MUST：转写走 provider-whisperx-local）。
 *
 * 不 spawn：`programs up` 即便服务已在跑也要 18 秒，体检每次开设置页都要跑。
 * 只看磁盘 + 问一下服务的 /health。按顺序判：
 *
 * - 端口被别的东西占着 / 服务卡死：fail 且挡路，转写必然失败。
 * - 服务健康：pass。
 * - 没装（没有 .venv）：warn。首次转写时 programs up 会安装，但要下载环境与模型，
 *   可能撑爆单步 10 分钟，建议先手动跑。「装了」看 .venv 而不是程序目录：
 *   programs up 一开始就建目录，装到一半失败也会留下它（复审第二轮 M2）。
 * - 装了但缺 NLTK punkt_tab：fail 且挡路。WhisperX 对齐要用它，首次启动时从
 *   raw.githubusercontent.com 下载；本机那个域名被 DNS 污染，解析结果里混了一个
 *   `::`，hypit 的安全层判为 SSRF 直接拒掉，报错指向安全层，看不出是缺数据
 *   （DEV-PLAN Phase 4 实测）。放进去之后 hypit 断言命中就不碰网络。
 * - 装好了但服务没在跑（重启电脑后必然）：warn。证据流水线转写前会自动拉起
 *   （hypit/whisperx-service.ts），首次约 1–3 分钟。
 */

const PUNKT_TAB_URL = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/tokenizers/punkt_tab.zip";

/**
 * hypit 的宿主状态目录。照抄 runtime-host-node 的 `hypitHostStateRoot`：
 * 不能 import 它（hypit-main 不是我们的依赖），路径算错就会永远报「未安装」。
 */
export function hypitStateRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const override = env.HYPIT_STATE_HOME;
  if (override && override.trim()) return path.resolve(override);
  const home = homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Hypit");
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return path.join(local && local.trim() ? local : path.join(home, "AppData", "Local"), "Hypit");
  }
  const state = env.XDG_STATE_HOME;
  return path.join(state && state.trim() ? state : path.join(home, ".local", "state"), "hypit");
}

/**
 * `programs` 要从工作目录解析 Runtime Profile，脱离工作目录跑会报
 * 「programs requires a Runtime」（复审实测）。取最近用过、配置还在的模板工作目录。
 */
export function findWorkspace(): string | undefined {
  const rows = db()
    .prepare("SELECT workspace_path FROM templates WHERE workspace_path IS NOT NULL ORDER BY updated_at DESC")
    .all() as { workspace_path: string }[];
  return rows.map((r) => r.workspace_path).find((ws) => existsSync(path.join(ws, "hypit.runtime.json")));
}

export interface WhisperXCheckInput {
  stateRoot?: string;
  hypitRoot?: string;
  /** 给修复命令用的工作目录。不传就查库（findWorkspace），null 表示没有 */
  workspace?: string | null;
  probe?: () => Promise<WhisperXProbe>;
}

export async function checkWhisperX(input: WhisperXCheckInput = {}): Promise<CheckResult> {
  const base = { id: "whisperx", name: "WhisperX 本地转写" } as const;
  try {
    const stateRoot = input.stateRoot ?? hypitStateRoot();
    const programDir = path.join(stateRoot, "programs", WHISPERX_PROGRAM_DIR);
    const workspace = input.workspace === undefined ? findWorkspace() : input.workspace;
    const upCommand = workspace
      ? `node "${path.join(input.hypitRoot ?? config.hypitRoot, "bin", "hypit.mjs")}" programs up ` +
        `--endpoint ${WHISPERX_ENDPOINT_ID} --workspace "${workspace}"`
      : null;
    const noWorkspace = upCommand ? "" : "（先新建一个模板，体检才能给出启动命令）";

    const service = await (input.probe ?? (() => probeWhisperX()))();
    if (service === "foreign") {
      return { ...base, blocking: true, status: "fail", detail: PORT_TAKEN_MESSAGE, fix: null };
    }
    if (service === "up") {
      return { ...base, blocking: false, status: "pass", detail: `服务运行中 · ${WHISPERX_HOST}:${WHISPERX_PORT}` };
    }

    if (!existsSync(path.join(programDir, ".venv", "pyvenv.cfg"))) {
      return {
        ...base,
        blocking: false,
        status: "warn",
        detail:
          `未安装。首次导入时会自动安装，但要下载环境与模型，可能超过单步 10 分钟，建议先手动执行${noWorkspace}。` +
          "安装若报「SSRF attempt to restricted IP ::」，重新体检按缺 punkt_tab 的指引修",
        fix: upCommand,
      };
    }

    // 看一个具体文件而不只是目录：解压到一半的空目录也会让对齐阶段才炸
    const punkt = path.join(programDir, "nltk_data", "tokenizers", "punkt_tab");
    if (!existsSync(path.join(punkt, "english", "collocations.tab"))) {
      const dest = path.join(programDir, "nltk_data", "tokenizers");
      return {
        ...base,
        blocking: true,
        status: "fail",
        detail:
          "缺 NLTK punkt_tab，转写会报「SSRF attempt to restricted IP ::」。在 PowerShell 里执行修复命令手动下载解压",
        // PowerShell 走系统解析器，优先连 IPv4，不受 hypit 安全层对 `::` 的拦截（本机实测可下）
        fix:
          `Invoke-WebRequest ${PUNKT_TAB_URL} -UseBasicParsing -OutFile "$env:TEMP\\punkt_tab.zip"; ` +
          `Expand-Archive "$env:TEMP\\punkt_tab.zip" -DestinationPath "${dest}" -Force`,
      };
    }

    return {
      ...base,
      blocking: false,
      status: "warn",
      detail: `已安装，服务未运行。导入时会自动启动（约 1–3 分钟），也可先手动启动${noWorkspace}`,
      fix: upCommand,
    };
  } catch (error) {
    // 读不了状态目录之类：只坏这一行，不能让整个体检接口 500（复审 M3）
    return {
      ...base,
      blocking: false,
      status: "fail",
      detail: `读取 WhisperX 状态失败：${error instanceof Error ? error.message : String(error)}`,
      fix: null,
    };
  }
}
