import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import { db } from "../db/index.js";
import { HypitError, runHypit } from "../hypit/cli.js";
import { PROFILE_FILENAME, refreshRuntimeProfile } from "../hypit/workspace.js";
import { credentialEnv } from "../lib/secrets.js";
import { notify } from "../agent/agent-service.js";
import { workspaceServices } from "./archive.js";
import { latestActivity } from "./build-activity.js";
import { judgeBuild, parseProgressLine, type BuildProgress } from "./build-progress.js";
import { setProductionStatus, updateBuild, type BuildContext, type ProductionRow } from "./build-store.js";

/**
 * 一次出片的执行过程（REQ-006 出片、AC-020）。三步都是 hypit 子进程，key 只进它们的环境：
 * 1. `hypit build <run> --json` 提交，立刻拿到 build id 落台账——之后任何时刻取消都能把 id 告诉 hypit
 *    （`--follow` 在 JSON 模式下到结束才给 id；hypit 自己也说 Ctrl-C 只是不看了、Build 照跑）。
 *    提交这一步不接取消信号：半路杀掉它拿不到 id，Worker 上的 build 就成了没人管的孤儿；等它返回再取消
 * 2. `hypit status <id> --watch --json --verbose` 跟到结束：stderr 进度行喂 CMP-007，最终 JSON 只看 `result.outcome`；
 *    `--verbose` 是为了 receipt——不带它，完成了的远程操作连同 receipt 一起被 hypit 过滤掉（view.ts buildStatusView）
 * 3. `hypit get` 导出到 output/
 * 提交后被取消、看的过程超时或炸了：都先让 hypit 取消这条 build，别让 Worker 继续花钱。
 */

export interface RunningBuild {
  buildId: string;
  dir: string;
  controller: AbortController;
  progress: BuildProgress | null;
}

/** build 跑多久算超时：本机 4112 帧渲染实测 26 分钟，留足余量 */
const BUILD_TIMEOUT_MS = 3 * 60 * 60_000;
const SUBMIT_TIMEOUT_MS = 10 * 60_000;

export interface ExecuteHooks {
  onProgress: () => void;
  log: (obj: object, msg: string) => void;
  /** 同一工作目录里其它正在跑的 build 的 hypit id：猜孤儿时要把它们排除掉，别把别人的 build 取消了 */
  knownHypitBuildIds: () => string[];
}

export async function execute(production: ProductionRow, entry: RunningBuild, hooks: ExecuteHooks): Promise<void> {
  const dir = entry.dir;
  const subject = { kind: "production", id: production.id };
  const signal = entry.controller.signal;
  const finish = (patch: Record<string, unknown>, productionStatus: string): void => {
    const now = new Date().toISOString();
    updateBuild(entry.buildId, { ...patch, ended_at: now });
    // 渲染中被作废（④ 变体「取消」= 出片单位记已取消）：收尾不能把它改回失败 / 完成
    setProductionStatus(production.id, productionStatus, now, { unlessCancelled: true });
  };
  const context = () => JSON.stringify(contextNow(entry));
  const fail = (code: string, message: string, extra: Record<string, unknown> = {}): void => {
    finish({ status: "failed", error_code: code, error_message: message, context_json: context(), ...extra }, "failed");
  };
  /** 人取消了（或 hypit 说 cancelled）：build 记 cancelled、出片单位回到 failed（可重试）；「已取消」在出片单位上是作废的意思 */
  const cancelled = (message = "已取消出片", extra: Record<string, unknown> = {}): void => {
    finish(
      { status: "cancelled", error_code: "CANCELLED", error_message: message, context_json: context(), ...extra },
      "failed",
    );
  };
  const failText = (e: unknown): string =>
    e instanceof HypitError ? [e.message, e.help, e.raw].filter(Boolean).join("\n") : String(e);

  try {
    // 出片前不信任 Agent 会话之后留下的 Runtime Profile（REQ-003）
    refreshRuntimeProfile(dir, workspaceServices());
    const env = credentialEnv();
    const runPath = production.run_path as string;

    // 1. 提交（不接取消信号，见文件头）
    let submitted: unknown;
    try {
      submitted = (
        await runHypit(["build", runPath, "--runtime", PROFILE_FILENAME, "--workspace", dir, "--json"], {
          cwd: dir,
          subject,
          env,
          timeoutMs: SUBMIT_TIMEOUT_MS,
        })
      ).json;
    } catch (e) {
      // 提交超时 / 炸了：hypit 可能已经把 build 排上了。activity 帧里除去别人的之外若只剩一条活跃 build，就是它，取消掉
      const orphan = orphanCandidate(dir, hooks.knownHypitBuildIds());
      if (orphan) await cancelHypitBuild(dir, orphan, subject, env);
      if (signal.aborted) return cancelled();
      return fail(e instanceof HypitError ? e.code : "BUILD_SPAWN", failText(e));
    }
    const hypitBuildId = judgeBuild(submitted).buildId;
    if (!hypitBuildId) return fail("BUILD_NO_ID", "hypit build 提交了但没有报出 build id，没法跟进度或取消");
    updateBuild(entry.buildId, { hypit_build_id: hypitBuildId });
    const cancelRemote = () => cancelHypitBuild(dir, hypitBuildId, subject, env);
    if (signal.aborted) {
      // 提交期间人点了取消：hypit 那边已经排上了，得让它停
      await cancelRemote();
      return cancelled();
    }

    // 2. 跟到结束
    let finalJson: unknown;
    try {
      finalJson = (
        await runHypit(["status", hypitBuildId, "--workspace", dir, "--watch", "--json", "--verbose"], {
          cwd: dir,
          subject,
          env,
          timeoutMs: BUILD_TIMEOUT_MS,
          signal,
          onStderrLine: (line) => {
            const p = parseProgressLine(line);
            if (!p) return;
            entry.progress = p;
            hooks.onProgress();
          },
        })
      ).json;
    } catch (e) {
      if (signal.aborted) return cancelled();
      // 看的进程超时或炸了：Worker 上的 build 可能还在跑，先停它再记失败
      await cancelRemote();
      return fail(e instanceof HypitError ? e.code : "BUILD_WATCH", failText(e));
    }
    const verdict = judgeBuild(finalJson);
    const receipt = pickReceipt(finalJson);
    const receiptPatch = { receipt_id: receipt?.id ?? null, receipt_url: receipt?.url ?? null };
    if (verdict.outcome === "cancelled") return cancelled(verdict.failure ?? "已取消出片", receiptPatch);
    if (verdict.outcome === "unknown") {
      // status 在「需要处理」（attention）时会自己退出、result 缺失：Worker 上那条 build 还挂着，先取消它
      await cancelRemote();
    }
    if (verdict.outcome !== "complete") {
      return fail(
        "BUILD_FAILED",
        verdict.failure ?? `hypit build 结束但结果不是 complete（${verdict.outcome}）`,
        receiptPatch,
      );
    }
    const target = verdict.targets[0];
    if (!target) return fail("BUILD_NO_TARGET", "hypit build 成功但没有报出目标名，无法导出", receiptPatch);

    // 3. 导出到工作目录的 output/：文件名带出片单位与版本，重出不会覆盖上一版
    mkdirSync(join(dir, "output"), { recursive: true });
    const outName = `${production.kind}-v${production.version}-${entry.buildId.slice(0, 8)}.mp4`;
    const outPath = join(dir, "output", outName);
    let got: { kind?: unknown; path?: unknown };
    try {
      got = (
        await runHypit<{ kind?: unknown; path?: unknown }>(
          ["get", hypitBuildId, "--output", target, "--to", outPath, "--workspace", dir, "--json"],
          { cwd: dir, subject, env, timeoutMs: 10 * 60_000, signal },
        )
      ).json;
    } catch (e) {
      if (signal.aborted) return cancelled("已取消出片（导出时）", receiptPatch);
      return fail("GET_FAILED", failText(e), receiptPatch);
    }
    const file = exportedFile(got, outPath);
    if (!file) {
      return fail("OUTPUT_MISSING", `hypit get 说导出到了 ${String(got.path)}，但那里没有可用的 mp4`, receiptPatch);
    }
    finish({ status: "done", output_path: file, ...receiptPatch }, "done");
    // 复刻片出完：模板进入验货（③ 验货，Phase 7）
    if (production.kind === "replica") {
      db()
        .prepare("UPDATE templates SET status = 'awaiting_review', updated_at = ? WHERE id = ? AND status = 'cloning'")
        .run(new Date().toISOString(), production.template_id);
      notify("global", "archive", { kind: "template", action: "status", id: production.template_id });
    }
  } catch (error) {
    hooks.log({ productionId: production.id, error }, "出片执行器内部出错");
    try {
      fail("BUILD_INTERNAL", String(error));
    } catch (again) {
      // 连记失败都失败（库关了之类）：只能留日志，别把它变成 unhandled rejection
      hooks.log({ productionId: production.id, error: again }, "出片失败也没记下来");
    }
  }
}

/** 让 hypit 取消这条 build。取消本身失败只记日志：人已经点了取消，宿主这边照样收尾 */
export async function cancelHypitBuild(
  dir: string,
  hypitBuildId: string,
  subject: { kind: string; id: string },
  env: Record<string, string> = credentialEnv(),
): Promise<boolean> {
  try {
    await runHypit(["cancel", hypitBuildId, "--workspace", dir, "--json"], {
      cwd: dir,
      subject,
      env,
      timeoutMs: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** activity 帧里不属于任何已知 build 的活跃 build：恰好一条才当作是刚提交没拿到 id 的那条 */
function orphanCandidate(dir: string, known: readonly string[]): string | null {
  const frame = latestActivity(dir);
  if (!frame) return null;
  const strangers = frame.builds.filter((b) => !known.includes(b.id));
  return strangers.length === 1 ? (strangers[0]?.id ?? null) : null;
}

/** get 的 kind 是 resource 时 path 就是文件；composite 时是目录（value.json + files/），取里面第一个 mp4 */
function exportedFile(got: { kind?: unknown; path?: unknown }, fallback: string): string | null {
  const p = typeof got.path === "string" ? got.path : fallback;
  if (existsSync(p) && statSync(p).isFile()) return p;
  const files = join(p, "files");
  if (existsSync(files)) {
    const mp4 = readdirSync(files).find((f) => f.toLowerCase().endsWith(".mp4"));
    if (mp4) return join(files, mp4);
  }
  return null;
}

/**
 * 台账记一条 receipt（REQ-009：`receipt.id` / `url` 若有）：一次 build 可能有多条远程操作，
 * 记第一条带 url 的（能点过去查账的），都没有 url 就记第一条；其余靠 `hypit inspect <id>` 看
 */
function pickReceipt(json: unknown): { id: string; url: string | null } | null {
  const ops = (json as { build?: { operations?: unknown } } | null)?.build?.operations;
  if (!Array.isArray(ops)) return null;
  const receipts: Array<{ id: string; url: string | null }> = [];
  for (const op of ops as Array<{ receipt?: { id?: unknown; url?: unknown } }>) {
    if (op?.receipt && typeof op.receipt.id === "string") {
      receipts.push({ id: op.receipt.id, url: typeof op.receipt.url === "string" ? op.receipt.url : null });
    }
  }
  return receipts.find((r) => r.url !== null) ?? receipts[0] ?? null;
}

function contextNow(entry: { progress: BuildProgress | null }): BuildContext {
  return { freeMemBytes: freemem(), totalMemBytes: totalmem(), lastProgress: entry.progress?.raw ?? null };
}
