import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { config, paths } from "../config.js";
import { db } from "../db/index.js";
import { hasSecret } from "../lib/secrets.js";
import { which } from "../lib/which.js";
import { codexReadiness } from "../hypit/codex.js";
import { codexPackageProblem } from "../hypit/codex-package.js";
import { checkWhisperX } from "./whisperx.js";

export type CheckStatus = "pass" | "fail" | "warn" | "checking";

export interface CheckResult {
  id: string;
  /** 是什么 */
  name: string;
  status: CheckStatus;
  /** 现状：一行说清当前到底是什么情况 */
  detail: string;
  /** 怎么修：可复制的命令，没有就为 null */
  fix?: string | null;
  /** P0 未过时要出琥珀横幅并挡住相关操作 */
  blocking: boolean;
  /** 可选项专用：虽没全过，但能启用（Codex：CLI 与登录都好，只差 Provider 包没同步上，启用或试图会重试同步） */
  ready?: boolean;
}

const NODE_MIN_MAJOR = 22;

async function run(
  exe: string,
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      // 体检里的 exe 要么是绝对路径（Node 自己、hypit CLI），要么是个命令名。
      // 命令名先经 which 解析：Windows 上 npm 全局命令是 .cmd 垫片，
      // 直接 spawn 名字会得到"不在 PATH"的假阴性。
      const resolved = exe.includes("\\") || exe.includes("/") ? null : which(exe);
      if (resolved === null && !exe.includes("\\") && !exe.includes("/")) {
        resolve({ code: -1, stdout: "", stderr: "not found in PATH" });
        return;
      }
      // .cmd / .bat 垫片在 Node 20+ 必须经 cmd.exe 起（CVE-2024-27980 之后禁止直接 spawn）。
      // 这里的参数全是本模块里的字面量（--version 之类），没有用户输入，不存在注入面。
      // 将来如果要用这条路跑带用户输入的命令，必须换成别的机制。
      const useCmd = resolved?.isBatch === true;
      child = useCmd
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", resolved.path, ...args], {
            shell: false,
            windowsHide: true,
            env: { ...process.env, NODE_OPTIONS: "" },
          })
        : spawn(resolved?.path ?? exe, args, {
            shell: false,
            windowsHide: true,
            env: { ...process.env, NODE_OPTIONS: "" },
          });
    } catch {
      resolve({ code: -1, stdout: "", stderr: "spawn failed" });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function checkNode(): Promise<CheckResult> {
  const major = Number(process.versions.node.split(".")[0]);
  const ok = Number.isFinite(major) && major >= NODE_MIN_MAJOR;
  return {
    id: "node",
    name: "Node.js",
    status: ok ? "pass" : "fail",
    detail: ok ? `v${process.versions.node}` : `v${process.versions.node}，Hypit 要求 ≥ ${NODE_MIN_MAJOR}`,
    fix: ok ? null : "winget install --id OpenJS.NodeJS.LTS -e",
    blocking: true,
  };
}

async function checkHypitDeps(): Promise<CheckResult> {
  if (!existsSync(paths.hypitCli)) {
    return {
      id: "hypit",
      name: "hypit-main 依赖",
      status: "fail",
      detail: `找不到 ${paths.hypitCli}`,
      fix: "把 Hypit 发行版放到仓库根的 hypit-main/，或设 CLONE_STUDIO_HYPIT_ROOT",
      blocking: true,
    };
  }
  if (!existsSync(path.join(config.hypitRoot, "node_modules"))) {
    return {
      id: "hypit",
      name: "hypit-main 依赖",
      status: "fail",
      detail: "hypit-main/node_modules 不存在，依赖没装",
      fix: `cd "${config.hypitRoot}" && pnpm install --frozen-lockfile`,
      blocking: true,
    };
  }
  const { code, stdout } = await run(process.execPath, [paths.hypitCli, "--version"], 60_000);
  const version = stdout.trim();
  const ok = code === 0 && version.length > 0;
  return {
    id: "hypit",
    name: "hypit-main 依赖",
    status: ok ? "pass" : "fail",
    detail: ok ? `已安装 · ${version}` : "CLI 跑不起来",
    fix: ok ? null : `cd "${config.hypitRoot}" && pnpm install --frozen-lockfile`,
    blocking: true,
  };
}

async function checkBinary(
  id: string,
  name: string,
  exe: string,
  args: readonly string[],
  fix: string,
  blocking: boolean,
  parse: (stdout: string, stderr: string) => string,
): Promise<CheckResult> {
  const { code, stdout, stderr } = await run(exe, args);
  const ok = code === 0;
  return {
    id,
    name,
    status: ok ? "pass" : "fail",
    detail: ok ? parse(stdout, stderr) : "不在 PATH",
    fix: ok ? null : fix,
    blocking,
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? "";
}

async function checkFfmpeg(): Promise<CheckResult> {
  // ffmpeg 与 ffprobe 必须成对存在：证据准备用 ffprobe，出片校验也用它
  const ffmpeg = await run("ffmpeg", ["-version"]);
  const ffprobe = await run("ffprobe", ["-version"]);
  const ok = ffmpeg.code === 0 && ffprobe.code === 0;
  const missing = [ffmpeg.code === 0 ? null : "ffmpeg", ffprobe.code === 0 ? null : "ffprobe"].filter(Boolean);
  return {
    id: "ffmpeg",
    name: "ffmpeg / ffprobe",
    status: ok ? "pass" : "fail",
    // detail 不重复 name：横幅是 "<name> <detail>" 拼出来的，重复会变成
    // "ffmpeg / ffprobe ffmpeg / ffprobe 不在 PATH"
    detail: ok
      ? firstLine(ffmpeg.stdout).replace(/^ffmpeg version /, "")
      : missing.length === 2
        ? "不在 PATH"
        : `只有 ${missing[0]} 不在 PATH`,
    fix: ok ? null : "winget install --id Gyan.FFmpeg.Shared -e",
    blocking: true,
  };
}

async function checkUv(): Promise<CheckResult> {
  return checkBinary(
    "uv",
    "uv（WhisperX 运行时）",
    "uv",
    ["--version"],
    "winget install --id astral-sh.uv -e",
    false,
    (stdout) => firstLine(stdout),
  );
}

/**
 * Codex 订阅生图（REQ-011）：CLI ≥ 0.128 且 `$CODEX_HOME/auth.json` 在（只看在不在，不读内容）。
 * 可选项：没过不挡别的操作，只是设置页的启用开关不让开（AC-033）。
 */
export async function checkCodex(): Promise<CheckResult> {
  const r = await codexReadiness();
  const base = { id: "codex", name: "Codex CLI（订阅生图，可选）", blocking: false } as const;
  const pkg = codexPackageProblem();
  if (r.ready && pkg) {
    // CLI 与登录都好，但 Provider 包没进数据根：开着也不会绑定出图（11.2 审查 M1）。修法不是一条命令——
    // 打开开关、试出一张图都会当场重试同步，所以 ready 仍为 true（11.3 审查 S1-M1）
    return {
      ...base,
      status: "warn",
      detail: `codex-cli ${r.version ?? ""} · 已登录 · ${pkg}（打开开关或试出一张图会重试同步）`,
      fix: null,
      ready: true,
    };
  }
  if (r.ready)
    return { ...base, status: "pass", detail: `codex-cli ${r.version ?? ""} · 已登录`, fix: null, ready: true };
  const version = r.version ? `codex-cli ${r.version} · ` : "";
  return { ...base, status: "warn", detail: `${version}${r.problem ?? "没准备好"}`, fix: r.fix, ready: false };
}

async function checkClaudeLogin(): Promise<CheckResult> {
  // Agent SDK 自带 Claude Code；这里只看本机是否有可用的订阅凭据或 API key
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const credPath = path.join(homedir(), ".claude", ".credentials.json");
  const hasSubscription = existsSync(credPath);
  const ok = hasApiKey || hasSubscription;
  return {
    id: "claude",
    name: "Claude Code 登录",
    status: ok ? "pass" : "fail",
    detail: hasSubscription ? "订阅已登录" : hasApiKey ? "使用 ANTHROPIC_API_KEY" : "未登录且无 API key",
    fix: ok ? null : "claude login",
    blocking: true,
  };
}

async function checkChromium(): Promise<CheckResult> {
  // 渲染用的 Chrome Headless Shell 由 hypit 自己装到用户缓存目录，不在 hypit-main 里。
  // 路径取自 doctor 的 HYPERFRAMES_BROWSER_SELECTION 诊断实测输出。
  const shellPath = path.join(homedir(), ".cache", "hyperframes", "chrome");
  const present = existsSync(shellPath);
  return {
    id: "chromium",
    name: "Chrome Headless Shell（渲染）",
    status: present ? "pass" : "warn",
    detail: present ? "已准备" : "未准备，首次出片时会自动下载",
    fix: present ? null : "hypit runtime up --runtime <profile>",
    blocking: false,
  };
}

async function checkTokenDance(): Promise<CheckResult> {
  const configured = hasSecret("tokendance.apiKey");
  // 只"配置了"不等于"能用"：AC-023 要求 key 错时出片按钮保持禁用，
  // 所以这一项要看验证时间，没验证过一律算未过。
  const row = db().prepare("SELECT tokendance_verified_at AS at FROM settings WHERE id = 1").get() as
    { at: string | null } | undefined;
  const verifiedAt = row?.at ?? null;
  const ok = configured && verifiedAt !== null;
  return {
    id: "tokendance",
    name: "TokenDance API key",
    status: ok ? "pass" : "fail",
    detail: !configured ? "未配置" : verifiedAt ? `已验证 · ${verifiedAt}` : "已配置，未验证",
    fix: ok ? null : "在设置页填入 TokenDance key 并点验证",
    blocking: true,
  };
}

/**
 * 跑全部体检。各项之间互不依赖，并行跑。
 * 注意：这里不判定 key 是否有效——验证 key 要真去打一次 hypit doctor，
 * 那是"验证"按钮的事（AC-023），不该每次开设置页都打一遍远端。
 */
export async function runAllChecks(): Promise<CheckResult[]> {
  return Promise.all([
    checkNode(),
    checkHypitDeps(),
    checkFfmpeg(),
    checkUv(),
    checkWhisperX(),
    checkChromium(),
    checkClaudeLogin(),
    checkTokenDance(),
    checkCodex(),
  ]);
}

export interface HealthSummary {
  checks: CheckResult[];
  passed: number;
  total: number;
  /** 未通过的 P0 项，界面据此出琥珀横幅 */
  blockingFailures: CheckResult[];
}

export async function healthSummary(): Promise<HealthSummary> {
  const checks = await runAllChecks();
  return {
    checks,
    passed: checks.filter((c) => c.status === "pass").length,
    total: checks.length,
    blockingFailures: checks.filter((c) => c.blocking && c.status === "fail"),
  };
}

/**
 * 验证 TokenDance key（AC-023）。
 *
 * 为什么不用 `hypit doctor --endpoint tokendance.default`（DEV-PLAN 原本的写法）：
 * 实测它对一个故意写错的 key 也返回 ok=true。doctor 只校验 Profile 形态与本地可用性，
 * hypit 全仓库没有任何"校验远端凭据"的命令——`auth status` 也只报凭据在不在。
 *
 * 为什么不用模型目录接口：`GET /gateway/v1/models` 是公开的，不带 key 也回 200。
 *
 * 实际做法：往生成接口发一个**结构合法但模型名故意不存在**的请求。实测网关的处理顺序是
 * 体解析 → 鉴权 → 模型校验，所以：
 *   - key 无效 → 401 `{"error":{"message":"API 密钥不存在","code":"unauthorized"}}`
 *   - 没有 key → 401 `{"error":{"message":"缺少 API 密钥"}}`
 *   - key 有效 → 卡在模型校验（非 401），不会建任务、不产生费用
 * 401/403 判为 key 无效并把服务端原文回给界面，其余判为鉴权通过。
 */
const PROBE_URL = "https://tokendance.space/gateway/ark/v3/generations/tasks";
const PROBE_BODY = JSON.stringify({
  // 故意不存在的模型名：确保就算鉴权过了也不会真的提交一个付费任务
  model: "__clone_studio_probe_nonexistent__",
  content: [{ type: "text", text: "probe" }],
});

export async function verifyTokenDance(apiKey: string | undefined): Promise<{
  ok: boolean;
  status?: number;
  /** 服务端响应原文，界面原样展示 */
  detail?: string;
  error?: string;
}> {
  if (!apiKey) return { ok: false, error: "未配置 TokenDance key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(PROBE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: PROBE_BODY,
      signal: controller.signal,
    });
    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: response.status, detail: body.slice(0, 2000) };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}
