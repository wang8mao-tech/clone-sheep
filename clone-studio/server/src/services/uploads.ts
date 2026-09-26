import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { paths } from "../config.js";

/** 上传后一天还没被导入的，当作放弃了 */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/**
 * 清掉放太久的上传文件（Task 4.3 审查 S4）。
 *
 * 上传成功后文件停在 uploads/，要等 POST /evidence 的 fetch 步骤把它挪进模板
 * 工作目录。用户传完就走、或者点火前就失败（模板正忙、参数不合法）时没人来
 * 挪，单个最大 500 MB，不清就一直堆着。启动时跑一遍，与 purgeTrash 同一时机。
 *
 * 按修改时间判：刚传完、正等人点「开始复刻」的文件不能动。
 */
export function purgeStaleUploads(now: number = Date.now(), dir: string = paths.uploads): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let purged = 0;
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const info = statSync(file);
      if (!info.isFile() || now - info.mtimeMs < STALE_UPLOAD_MS) continue;
      rmSync(file, { force: true });
      purged += 1;
    } catch {
      // 单个文件删不掉（被占用）不该挡住启动，下次再来
    }
  }
  return purged;
}
