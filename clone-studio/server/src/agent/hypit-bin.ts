import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, paths } from "../config.js";

/**
 * 给 Agent 的 PATH 放一个 `hypit` 启动器（Spec REQ-003）。
 *
 * hypit-main 不是全局安装的：不放启动器，Agent 只能自己找 hypit.mjs 的路径，或照 hypit skill
 * 的建议 `npm install --global @hypit/hypit`——后者改宿主全局环境，还会装出一个和宿主版本
 * 不一致的 hypit。启动器转调宿主用的同一个 node 与同一份 hypit-main。
 *
 * 两个文件：`hypit.cmd` 给 PowerShell / cmd，`hypit`（sh 脚本）给 Claude Code 在 Windows 上
 * 用的 Git Bash。目录放数据根下，guard 禁止 Agent 改它。
 */
export function agentBinDir(): string {
  return path.join(config.dataRoot, "agent-bin");
}

/** 确保启动器就绪，返回目录绝对路径 */
export function ensureHypitBin(node: string = process.execPath, cli: string = paths.hypitCli): string {
  const dir = agentBinDir();
  mkdirSync(dir, { recursive: true });
  const posix = (p: string) => p.replace(/\\/g, "/");
  writeIfChanged(path.join(dir, "hypit.cmd"), `@echo off\r\n"${node}" "${cli}" %*\r\n`);
  writeIfChanged(path.join(dir, "hypit"), `#!/bin/sh\nexec "${posix(node)}" "${posix(cli)}" "$@"\n`);
  return dir;
}

function writeIfChanged(file: string, content: string): void {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return;
  writeFileSync(file, content, { mode: 0o755 });
}
