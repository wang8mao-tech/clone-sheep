import { homedir } from "node:os";
import path from "node:path";
import { isInside, realpathOrUndefined } from "../lib/safe-path.js";

/** guard 用的路径解析与比较：Agent 给的路径五花八门，先还原成真实的绝对路径再判断 */

/**
 * 把 Agent 给的路径解析成绝对路径：`~`、Git Bash 的 `/c/…` 与 `/cygdrive/c/…`、`\\?\` 前缀、
 * NTFS 数据流后缀都先还原——它们是 Windows 上的日常写法，不还原就会按工作目录的盘符错解。
 */
export function resolveFrom(base: string, p: string): string {
  let s = p;
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(homedir(), s.slice(1));
  if (path.sep === "\\") {
    s = s.replace(/^\\\\\?\\/, "");
    const msys = /^\/(?:cygdrive\/)?([a-zA-Z])(?=\/|$)/.exec(s);
    if (msys) s = `${msys[1] as string}:${s.slice(msys[0].length) || "/"}`;
  }
  return path.resolve(base, stripStream(s));
}

/** 去掉 NTFS 数据流后缀：`secrets.json::$DATA`、`secrets.json:x` 读的都是它 */
function stripStream(p: string): string {
  const drive = /^[a-zA-Z]:/.test(p) ? p.slice(0, 2) : "";
  const rest = p.slice(drive.length);
  const colon = rest.indexOf(":");
  return colon < 0 ? p : drive + rest.slice(0, colon);
}

/** 比真实路径：8.3 短名、junction、大小写都解开了再比 */
function real(p: string): string {
  const literal = path.resolve(p);
  try {
    return realpathOrUndefined(literal) ?? literal;
  } catch {
    return literal;
  }
}

export function samePath(a: string, b: string): boolean {
  return path.relative(real(a), real(b)) === "" || path.relative(path.resolve(a), path.resolve(b)) === "";
}

export function containsPath(root: string, target: string): boolean {
  return isInside(real(root), real(target)) || isInside(path.resolve(root), path.resolve(target));
}
