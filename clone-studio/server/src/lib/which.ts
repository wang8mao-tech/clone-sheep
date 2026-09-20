import { execFileSync } from "node:child_process";

export interface ResolvedBinary {
  /** 真实可执行文件的绝对路径 */
  path: string;
  /** .cmd / .bat 垫片：Node 20 起出于 CVE-2024-27980 禁止 shell:false 直接 spawn 它们 */
  isBatch: boolean;
}

const cache = new Map<string, ResolvedBinary | null>();

/**
 * 在 PATH 里找一个命令。
 *
 * 为什么不直接 spawn 名字：Windows 上 npm 全局安装的命令（codex、claude 等）是
 * `.cmd` 垫片，`shell: false` 的 spawn 根本解析不到，会得到"不在 PATH"的假阴性。
 * 这里用 `where.exe` 拿到真实路径，并标出它是不是批处理垫片。
 */
export function which(name: string): ResolvedBinary | null {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  let resolved: ResolvedBinary | null = null;
  try {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(finder, [name], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const candidates = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // where.exe 会把无扩展名的那条也列出来（那是 shell 脚本，Windows 上跑不了），
    // 优先挑 .exe，其次 .cmd/.bat
    const exe = candidates.find((c) => /\.exe$/i.test(c));
    const batch = candidates.find((c) => /\.(cmd|bat)$/i.test(c));
    const pick = exe ?? batch ?? candidates[0];
    if (pick) resolved = { path: pick, isBatch: /\.(cmd|bat)$/i.test(pick) };
  } catch {
    resolved = null;
  }

  cache.set(name, resolved);
  return resolved;
}

/** 测试用：清掉缓存 */
export function clearWhichCache(): void {
  cache.clear();
}
