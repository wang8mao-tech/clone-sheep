import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { paths } from "../config.js";
import { isReallyInside } from "../lib/safe-path.js";
import { ArchiveError } from "./archive.js";
import { latestBuildRow } from "./build-store.js";
import { outputName, readOutputRow } from "./output-store.js";

/**
 * ⑤ 多选打包下载（REQ-007、AC-021）：zip 里每个 mp4 以成片名命名。
 * mp4 本来就压过，这里只 store 不压缩；先逐个算 CRC，再流式写出，不把整包攒在内存里。
 * 不写 ZIP64：整包超过 4 GB 或超过 65535 条直接拒绝（成片是几十 MB 量级）。
 * 两遍之间文件被改了：大小变了会中断下载；大小没变的改写查不出来，会得到一条 CRC 对不上的条目（解压时报错），
 * 成片出完就不再写，风险低，不为它再读第三遍。
 */

export interface ZipEntry {
  name: string;
  file: string;
  size: number;
  mtime: Date;
}

const ZIP_LIMIT = 0xffffffff;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Windows 不允许的字符换成「_」，去掉结尾的点和空格，保留设备名前面加「_」，空了用「成片」 */
export function safeFileStem(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let stem = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  stem = stem.replace(/[. ]+$/, "");
  if (!stem) stem = "成片";
  if (RESERVED.test(stem)) stem = `_${stem}`;
  return stem;
}

/** 重名（不分大小写）依次加「 (2)」「 (3)」 */
export function uniqueNames(stems: readonly string[], ext = ".mp4"): string[] {
  const used = new Set<string>();
  return stems.map((stem) => {
    let name = `${stem}${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** 选中的成片 → 打包清单：只收这个模板下、完成且文件还在数据根里的；有一条不行就整批拒绝并说是哪条 */
export function zipEntries(templateId: string, ids: readonly string[]): ZipEntry[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new ArchiveError("先勾选要下载的成片", "NOTHING_SELECTED", 400);
  const picked = unique.map((id) => {
    const row = readOutputRow(id);
    if (!row || row.template_id !== templateId || row.output_deleted_at) {
      throw new ArchiveError("选中的成片有一条不存在了，刷新后重选", "OUTPUT_NOT_FOUND", 404);
    }
    const build = latestBuildRow(id);
    const file = row.status === "done" && build?.status === "done" ? build.output_path : null;
    const info = file ? downloadableFile(file) : null;
    if (!file || !info) throw new ArchiveError(`「${outputName(row)}」还没有可下载的成片`, "OUTPUT_NOT_READY", 409);
    return { stem: safeFileStem(outputName(row)), file, size: info.size, mtime: info.mtime };
  });
  const names = uniqueNames(picked.map((p) => p.stem));
  const entries = picked.map((p, i) => ({
    name: names[i] ?? `${p.stem}.mp4`,
    file: p.file,
    size: p.size,
    mtime: p.mtime,
  }));
  checkZipSize(entries);
  return entries;
}

/** 不写 ZIP64：条目数与整包大小（含每条的本地头与目录项）都得在 32 位里 */
export function checkZipSize(entries: ReadonlyArray<Pick<ZipEntry, "name" | "size">>): void {
  const total = entries.reduce((s, e) => s + e.size + 30 + 46 + 2 * Buffer.byteLength(e.name), 22);
  if (entries.length > 0xffff || total > ZIP_LIMIT) {
    throw new ArchiveError("选中的成片合起来超过 4 GB，分几次下载", "ZIP_TOO_LARGE", 413);
  }
}

/** 成片文件能不能下载 / 打包：真实路径在数据根的 clients 下、是个普通文件。网格卡片的「能下载」也用它 */
export function downloadableFile(file: string): { size: number; mtime: Date } | null {
  return isReallyInside(paths.clients, file) ? statOrNull(file) : null;
}

function statOrNull(file: string): { size: number; mtime: Date } | null {
  try {
    const info = statSync(file);
    return info.isFile() ? { size: info.size, mtime: info.mtime } : null;
  } catch {
    return null;
  }
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function fileCrc(file: string): Promise<number> {
  let crc = 0;
  for await (const chunk of createReadStream(file)) crc = crc32(chunk as Buffer, crc);
  return crc;
}

/** 流式写出 zip；文件在两遍之间被改了大小就中断（宁可下载失败，不给坏包） */
export function zipStream(entries: readonly ZipEntry[]): Readable {
  return Readable.from(write(entries));
}

async function* write(entries: readonly ZipEntry[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const crc = await fileCrc(e.file);
    const name = Buffer.from(e.name, "utf8");
    const { time, date } = dosTime(e.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.size, 18);
    local.writeUInt32LE(e.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    yield local;
    yield name;
    let written = 0;
    for await (const chunk of createReadStream(e.file)) {
      written += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
    if (written !== e.size) throw new Error(`「${e.name}」在打包时被改动了，请重新下载`);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.size, 20);
    cd.writeUInt32LE(e.size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + e.size;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  yield* central;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}
