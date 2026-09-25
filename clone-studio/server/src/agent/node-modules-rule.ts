import path from "node:path";
import { isInside } from "../lib/safe-path.js";

/**
 * Agent 不许造 node_modules（11.2 审查 H1、第二轮 MEDIUM-1）。
 *
 * hypit 找非 @hypit 的包时从项目根（模板目录，最近的 package.json）往上逐级查 node_modules，**离得最近的优先**：
 * Agent 放一份同名包就盖掉宿主同步的 Codex Provider 包。宿主调 hypit 前也会查（hypit/shadow-packages.ts），
 * 查到就拒绝——那一层保证不执行 Agent 的代码；这里先拦一道，免得模板被一个 node_modules 卡死。
 *
 * 范围：会话工作目录，加上 hypit 认的项目根（变体会话的工作目录是 productions/<id>/，hypit 从模板根找）。
 * 本地装包命令（npm / pnpm / yarn / bun 的 install、i、add、ci）会在当前目录造 node_modules，一并拦。
 */

export const NODE_MODULES_WHY =
  "工作目录与模板目录里不许写 node_modules、也不许装包：hypit 会优先加载这里的包，盖掉宿主维护的 Provider 包（出图代码）";

/**
 * 命令开头或 ; & | ( 之后的装包命令；`echo npm install` 这类字面文字不算。
 * 允许 npx / corepack 前缀、Windows 的 .cmd 后缀，以及子命令前的选项（`npm --prefix ../.. install`、
 * `pnpm -C ../.. add`）；子命令后面可以是空白、结尾或 ) ; & |（11.2 第三轮审查 L-1）
 */
const LOCAL_INSTALL =
  /(^|[;&|(]\s*)(?:(?:npx|corepack)\s+)?(?:npm|pnpm|yarn|bun)(?:\.cmd)?(?:\s+-{1,2}[^\s;&|)]+(?:\s+[^\s;&|)-][^\s;&|)]*)?)*\s+(?:i|install|add|ci)(?=[\s);&|]|$)/im;

export function installsPackages(command: string): boolean {
  return LOCAL_INSTALL.test(command.trim());
}

/** 路径在某个根之内、且经过一级叫 node_modules 的目录 */
export function writesNodeModules(roots: readonly string[], p: string): boolean {
  return roots.some(
    (root) =>
      isInside(root, p) &&
      path
        .relative(root, p)
        .split(/[\\/]/)
        .some((part) => part.toLowerCase() === "node_modules"),
  );
}
