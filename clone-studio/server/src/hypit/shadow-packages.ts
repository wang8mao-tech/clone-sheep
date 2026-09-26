import { lstatSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { isInside } from "../lib/safe-path.js";
import { CODEX_PACKAGE } from "./runtime-profile.js";

/**
 * 宿主同步到数据根 node_modules 的 Provider 包（@clone-studio/*）会不会被盖掉（11.2 审查 H1）。
 *
 * hypit 找非 @hypit 的包时从工作目录往上逐级查 `node_modules/<包名>`，**离得最近的优先**。Agent 在工作目录里
 * （Write 工具就能写，不用 Bash）放一份同名包，宿主带着凭据环境跑 hypit 时加载的就是 Agent 的代码——等于绕过
 * 「不许改 Provider 包」和「不许读凭据」。@hypit/* 被发行版锁定、盖不掉，所以口子只在我们自己的作用域上。
 *
 * 查的是从 cwd 到数据根之间（不含数据根本身，那份是宿主同步的）每一级的 `node_modules/@clone-studio`；
 * 用 lstat，悬空的链接也算。不在数据根下的 cwd 不查：那是宿主自己的目录（体检、hypit-main）。
 */

/** 用到时再取：runtime-profile → whisperx-service → cli → 本模块成环，模块求值时 CODEX_PACKAGE 还没定义 */
const scope = (): string => CODEX_PACKAGE.split("/")[0] as string;

export function findShadowPackages(cwd: string): string[] {
  const root = path.resolve(config.dataRoot);
  let dir = path.resolve(cwd);
  if (dir === root || !isInside(root, dir)) return [];
  const found: string[] = [];
  while (dir !== root && isInside(root, dir)) {
    const candidate = path.join(dir, "node_modules", scope());
    try {
      lstatSync(candidate);
      found.push(candidate);
    } catch {
      /* 没有 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}
