import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { isReallyInside } from "../lib/safe-path.js";

/**
 * 变体工作目录里的文件（REQ-005）。一条变体一个目录：`<模板目录>/productions/<变体 id>/`。
 * 目录里放着从模板复制来的原稿（`reference.*`，Agent 以它为基础），Agent 写的稿子（`variant.*`）、
 * 素材（`assets/`）、来源清单（`SOURCES.json`）与台词全文（`SCRIPT.md`）。
 * hypit 按最近的 package.json 认项目根，所以在这个子目录里跑 check / plan / build 用的仍是模板的 Runtime；
 * 源文件里的相对引用按声明它的文件解析（hypit-main skills/hypit/references/creation/project-files.md）。
 */

export const TEMPLATE_SOURCES = ["reference.svml", "reference.svs", "reference.svrun"] as const;
export const VARIANT_RUN = "variant.svrun";
export const SOURCES_FILE = "SOURCES.json";
export const SCRIPT_FILE = "SCRIPT.md";
/** 重跑时留给新会话的清单：用户替换过、要原样保留的图 */
export const USER_ASSETS_FILE = "USER_ASSETS.json";
export const VARIANT_REQUIRED = [VARIANT_RUN, SOURCES_FILE, SCRIPT_FILE] as const;

export function variantDir(templateDir: string, productionId: string): string {
  return path.join(templateDir, "productions", productionId);
}

/** 运行文件相对模板目录的路径（出片单位的 run_path；估价与出片都在模板目录下跑） */
export function variantRunPath(productionId: string): string {
  return `productions/${productionId}/${VARIANT_RUN}`;
}

/** 复制模板原稿。模板必须有 reference.svrun（验货通过的模板一定有）；.svml / .svs 有就一起带上 */
export function copyTemplateSources(templateDir: string, dir: string): void {
  if (!existsSync(path.join(templateDir, "reference.svrun"))) {
    throw new Error("模板目录里没有 reference.svrun，变体没有原稿可依");
  }
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  for (const file of TEMPLATE_SOURCES) {
    const from = path.join(templateDir, file);
    if (existsSync(from)) copyFileSync(from, path.join(dir, file));
  }
}

const SourceEntry = z.object({
  file: z.string().min(1),
  label: z.string().optional(),
  sourceUrl: z.string().nullable().optional(),
  gap: z.boolean().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
const SourcesDoc = z.union([z.array(SourceEntry), z.object({ assets: z.array(SourceEntry) })]);

export interface SourceAsset {
  /** 相对变体目录，正斜杠 */
  file: string;
  label: string | null;
  sourceUrl: string | null;
  gap: boolean;
  width: number | null;
  height: number | null;
}

/**
 * 读 SOURCES.json。格式不对、路径跑出变体目录、非缺口的图文件不存在、同一个文件写了两次，都算没过判据
 * （抛错，原因给会话看）。数组或 `{ assets: [...] }` 两种写法都认。
 */
export function readSources(dir: string): SourceAsset[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dir, SOURCES_FILE), "utf8"));
  } catch (e) {
    throw new Error(`${SOURCES_FILE} 不是合法 JSON：${String(e)}`, { cause: e });
  }
  const parsed = SourcesDoc.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`${SOURCES_FILE} 格式不对：${first ? `${first.path.join(".")} ${first.message}` : "未知"}`);
  }
  const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.assets;
  const seen = new Set<string>();
  return entries.map((entry) => {
    const abs = path.resolve(dir, entry.file);
    // 统一成相对变体目录、正斜杠的写法：`assets//x`、`./assets/x` 与 `assets/x` 是同一个文件（8.1 审查 LOW）
    const file = path.relative(dir, abs).split(path.sep).join("/");
    if (!isReallyInside(dir, abs) || path.resolve(dir) === abs)
      throw new Error(`${SOURCES_FILE} 里的路径跑出了变体目录：${entry.file}`);
    // NTFS 不分大小写：ASSETS/x 与 assets/x 是同一个文件
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (seen.has(key)) throw new Error(`${SOURCES_FILE} 里同一个文件写了两次：${file}`);
    seen.add(key);
    const gap = entry.gap === true;
    // 缺口也要放同尺寸的占位图（提示词里这样要求，替换时按它的尺寸裁）；目录、清单文件都不算图
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${SOURCES_FILE} 列的图不存在：${file}`);
    if (!file.startsWith("assets/")) throw new Error(`${SOURCES_FILE} 列的图要放在 assets/ 下：${file}`);
    return {
      file,
      label: entry.label?.trim() || null,
      sourceUrl: webUrl(entry.sourceUrl),
      gap,
      width: entry.width ?? null,
      height: entry.height ?? null,
    };
  });
}

/**
 * 重跑前清掉 Agent 的产物（Task 5.2 复审 S1-M4）：留下用户替换过的图，其余全删；原稿从模板目录重新复制。
 * 留下的图列进 USER_ASSETS.json 交给新会话，让它直接用、别覆盖。返回删掉的顶层条目。
 *
 * 目录里的东西是 Agent 写的，可能有链接 / junction 指到外面（在自己目录里建链接是被允许的写入）：
 * 先验目录的真实路径确实是数据根里的某个 productions/<id>，删的时候逐项 lstat，链接只拆链接本身、绝不进去
 * （8.1 第二轮审查 HIGH-1：顺着 assets junction 把外面的文件删了；同 resetAgentProducts 的 Task 5.1 S1-M2）
 */
export function resetVariantProducts(dir: string, keepAssets: readonly string[], templateDir?: string): string[] {
  if (!existsSync(dir)) return [];
  const resolved = path.resolve(dir);
  const clients = path.join(config.dataRoot, "clients");
  if (
    !isReallyInside(clients, resolved) ||
    path.basename(path.dirname(resolved)) !== "productions" ||
    lstatSync(resolved).isSymbolicLink()
  ) {
    throw new Error(`不是变体工作目录，拒绝清理：${dir}`);
  }
  const keep = new Set(keepAssets.map((f) => pathKey(path.resolve(resolved, f))));
  const removed: string[] = [];
  for (const name of readdirSync(resolved)) {
    const abs = path.join(resolved, name);
    const st = lstatSync(abs);
    // 原稿：有模板目录就删了重拷一份干净的（下面）；拿不到模板目录时，只留没有别的硬链接的普通文件。
    // 硬链接也要当链接对待：往一个 nlink > 1 的文件里写，写的是外面那个文件（8.1 第三轮审查 HIGH-1）
    if ((TEMPLATE_SOURCES as readonly string[]).includes(name) && !templateDir && st.isFile() && st.nlink === 1) {
      continue;
    }
    // NTFS 不分大小写：Agent 改名成 Assets 也是这个目录，不能整个删掉把用户的图带走（8.1 第四轮审查 L3）
    const isAssets = process.platform === "win32" ? name.toLowerCase() === "assets" : name === "assets";
    if (isAssets && st.isDirectory() && !st.isSymbolicLink()) {
      clearAssets(abs, keep);
      continue;
    }
    removeNoFollow(abs);
    removed.push(name);
  }
  mkdirSync(path.join(resolved, "assets"), { recursive: true });
  // 原稿可能被上一个会话改过：从模板目录重新复制一份，新会话从干净的原稿开始（8.1 审查 LOW）
  if (templateDir) {
    for (const file of TEMPLATE_SOURCES) {
      const from = path.join(templateDir, file);
      const dest = path.join(resolved, file);
      // 先删目录项再写：写进一个新文件，绝不顺着 Agent 留下的硬链接写到别处
      rmSync(dest, { force: true });
      if (existsSync(from)) copyFileSync(from, dest);
    }
  }
  if (keepAssets.length > 0) {
    writeFileSync(
      path.join(resolved, USER_ASSETS_FILE),
      `${JSON.stringify({ assets: keepAssets }, null, 2)}\n`,
      "utf8",
    );
  }
  return removed;
}

/** 比较路径用的键：NTFS 不分大小写（Assets/x 与 assets/x 是同一个文件） */
function pathKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** 清 assets：留下要保留的普通文件，其余删；子目录照样清，链接只拆不进 */
function clearAssets(dir: string, keep: ReadonlySet<string>): void {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) unlinkLink(abs);
    else if (st.isDirectory()) clearAssets(abs, keep);
    else if (!keep.has(pathKey(abs))) rmSync(abs, { force: true });
  }
}

/** 删一个条目，永不跟随链接：目录自己一层层删，碰到链接只拆链接 */
function removeNoFollow(abs: string): void {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    unlinkLink(abs);
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) removeNoFollow(path.join(abs, name));
    rmdirSync(abs);
    return;
  }
  rmSync(abs, { force: true });
}

/** 拆链接本身：文件链接用 unlink；Windows 的目录 junction / 目录符号链接 unlink 不掉，用 rmdir（只删链接，不动目标） */
function unlinkLink(abs: string): void {
  try {
    unlinkSync(abs);
  } catch {
    rmdirSync(abs);
  }
}

/** 来源只认 http / https 网页地址：别的（javascript:、file:、乱写的）一律当作无来源，界面也就不会渲染成链接 */
function webUrl(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
