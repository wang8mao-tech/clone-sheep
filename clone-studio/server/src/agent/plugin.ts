import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { config, paths } from "../config.js";

/**
 * 给 Agent 预置 hypit skill 的插件目录（Spec REQ-003）。
 *
 * 会话必须 settingSources: []（不继承用户 ~/.claude），而那样 SDK 不从 .claude/skills 加载
 * 任何 skill。官方出路是 plugins 选项指向本地插件目录——2026-09-22 实测
 * （scripts/spike-plugin-skill.mjs）：settingSources: [] 下插件照常加载，skill 名为
 * `clone-studio:hypit`。
 *
 * 目录放在数据根下而不是工作目录里：工作目录 Agent 可写，放进去它就能改自己的 skill。
 * 数据根在 guard 看来是工作目录之外，写不到。内容按 hypit-main 里 skill 的指纹刷新，
 * hypit 升级后下一次会话自动换新，不用手动同步。
 */
export const PLUGIN_NAME = "clone-studio";
export const HYPIT_SKILL = `${PLUGIN_NAME}:hypit`;

export function agentPluginDir(): string {
  return path.join(config.dataRoot, "agent-plugin");
}

/** 确保插件目录就绪，返回它的绝对路径 */
export function ensureAgentPlugin(): string {
  const dir = agentPluginDir();
  const source = paths.hypitSkill;
  if (!existsSync(path.join(source, "SKILL.md"))) {
    throw new Error(`找不到 hypit skill：${source}。检查设置里的 hypit-main 路径。`);
  }
  const fingerprint = fingerprintOf(source);
  const stamp = path.join(dir, ".fingerprint");
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === fingerprint) return dir;

  // 先在旁边铺好再整体换上，缩短目录「半新半旧」的窗口。同一进程里 ensureAgentPlugin 是同步
  // 执行的，两个会话不会交错；残留风险只在 hypit 升级那一刻：还在跑的会话读的旧目录被换掉，
  // 它已经加载的 skill 不受影响，只是之后按需读 references 时拿到新版
  cleanStaleStaging(dir);
  const staging = `${dir}.staging-${process.pid}-${Date.now()}`;
  mkdirSync(path.join(staging, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(staging, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0", description: "Clone Studio 给 Agent 预置的 hypit 能力" }, null, 2)}\n`,
  );
  cpSync(source, path.join(staging, "skills", "hypit"), { recursive: true });
  writeFileSync(path.join(staging, ".fingerprint"), fingerprint);
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  return dir;
}

/** 清掉崩溃留下的 staging 目录：不清的话每次升级失败都留一份 hypit skill 副本 */
function cleanStaleStaging(dir: string): void {
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}.staging-`;
  if (!existsSync(parent)) return;
  for (const name of readdirSync(parent)) {
    if (name.startsWith(prefix)) rmSync(path.join(parent, name), { recursive: true, force: true });
  }
}

/** skill 目录的指纹：相对路径 + 大小 + 修改时间，够判断 hypit 升没升级，不必读全部内容 */
function fingerprintOf(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else h.update(`${path.relative(root, full)}\0${st.size}\0${st.mtimeMs}\n`);
    }
  };
  walk(root);
  return h.digest("hex");
}
