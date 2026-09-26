import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * 「这个路径在不在那个目录里」的唯一判断。上传导入与视频播放共用。
 *
 * 必须比较**真实路径**：只做字面比较的话，目录里的 junction / 符号链接能指到
 * 任何地方，字面上看它仍在数据根里（Task 4.3 审查 S3 实测绕过）。
 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  // 不能写 rel.startsWith("..")：那会误伤名字以 .. 开头的子目录（如 `..cache`）
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * 解析真实路径；不存在时返回 undefined，其余错误照抛。
 * 用 native 实现：JS 版在 Windows 上对 junction 的处理不如 libuv 可靠。
 */
export function realpathOrUndefined(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * 字面与真实路径都得在 root 里。root 本身也取真实路径：数据根可能就放在
 * 一个经 junction 挂进来的盘上，那时两边都要解开了才能比。
 *
 * 目标还不存在时，取它最近的已存在上级的真实路径，再把没建出来的那几段接回去：
 * 不这样的话，先建一个指到外面的 junction、再往里「新建」文件，字面判断照样放行
 * （Task 5.1 复审 S1-M2）。
 */
export function isReallyInside(root: string, target: string): boolean {
  const literalRoot = path.resolve(root);
  const literal = path.resolve(target);
  if (!isInside(literalRoot, literal)) return false;
  const realRoot = realpathOrUndefined(literalRoot) ?? literalRoot;

  let existing = literal;
  const missing: string[] = [];
  let real = realpathOrUndefined(existing);
  while (real === undefined) {
    const parent = path.dirname(existing);
    if (parent === existing) return true;
    missing.unshift(path.basename(existing));
    existing = parent;
    real = realpathOrUndefined(existing);
  }
  return isInside(realRoot, path.join(real, ...missing));
}
