import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { isReallyInside } from "../lib/safe-path.js";
import { buildRuntimeProfile, type WorkspaceServices } from "./runtime-profile.js";

/**
 * 模板工程目录生成器。
 *
 * 生成的目录是一个能被 `hypit doctor --workspace <dir> --json` 识别的 Hypit 工程：
 * 最小 package.json + hypit.runtime.json（内容见 runtime-profile.ts）。
 */

export const PROFILE_FILENAME = "hypit.runtime.json";

/**
 * 工作目录里必须存在的子目录。新建与存量迁移共用这一份清单——
 * 两边各写一份迟早会漂，而漂出来的差异只在存量模板上炸。
 *
 * **它同时是重跑时的保留清单**（resetAgentProducts）：往工作目录里加宿主自己产出的目录
 * （比如 Phase 6 导出成片的 `output/`）时必须加到这里，否则第一次重跑就把它删了。
 */
const WORKSPACE_DIRS = [["productions"], ["assets"], ["references", "src"], ["output"]] as const;

export interface CreateWorkspaceArgs {
  clientId: string;
  templateId: string;
  /** 只用于 package.json 的 name，不参与路径 */
  slug: string;
  services: WorkspaceServices;
}

export interface CreatedWorkspace {
  dir: string;
  profilePath: string;
}

/**
 * 建目录、写文件、并把 Runtime Profile **选中**。目录布局按 Spec 6.3：
 * <data>/clients/<clientId>/templates/<templateId>/
 *
 * 选中这一步不能省：hypit 只从该项目的 `.hypit/runtime` 读选择，既不按文件名
 * 发现 `hypit.runtime.json`，也不继承父目录。只写 profile 不选中的话，
 * `transcribe` 一律报「No Runtime Profile is selected」——Phase 2 就是这么漏的。
 *
 */
export function createWorkspace(args: CreateWorkspaceArgs): CreatedWorkspace {
  const dir = workspaceDir(args.clientId, args.templateId);
  // 已经存在就不是"本次新建"，出错时不能删——那会连别人的数据一起删掉
  const preexisting = existsSync(dir);
  mkdirSync(dir, { recursive: true });

  try {
    return writeWorkspaceFiles(dir, args);
  } catch (error) {
    // 半成品目录比没有更糟：它跑不了任何 hypit 命令，还占着这个 templateId
    if (!preexisting) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function writeWorkspaceFiles(dir: string, args: CreateWorkspaceArgs): CreatedWorkspace {
  const pkg = {
    name: `clone-studio-${sanitizeName(args.slug)}`,
    version: "0.0.0",
    private: true,
    type: "module",
    description: "Clone Studio 生成的 Hypit 工程目录，勿手工改动",
  };
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const profilePath = path.join(dir, PROFILE_FILENAME);
  writeFileSync(profilePath, `${JSON.stringify(buildRuntimeProfile(args.services), null, 2)}\n`, "utf8");

  ensureWorkspaceLayout(dir);

  return { dir, profilePath };
}

/**
 * 出片（以及估价用的 plan）前重写 Runtime Profile（Spec REQ-003 / REQ-006）：Agent 会话之后目录里那份
 * 可能被改过路由，宿主不信任它，按当前设置重新生成。写完保证仍被选中。
 */
export function refreshRuntimeProfile(dir: string, services: WorkspaceServices): string {
  const profilePath = path.join(dir, PROFILE_FILENAME);
  writeFileSync(profilePath, `${JSON.stringify(buildRuntimeProfile(services), null, 2)}\n`, "utf8");
  ensureRuntimeSelected(dir);
  return profilePath;
}

/** hypit 记录选择的地方。内容是 profile 文件名，相对该项目目录。 */
function selectionFile(dir: string): string {
  return path.join(dir, ".hypit", "runtime");
}

/**
 * 把一个工作目录补成「hypit 能跑、Clone Studio 能往里写」的完整形态。
 *
 * 幂等，且兼作存量模板的迁移入口：Phase 2 建出来的目录既没有 `.hypit/runtime`，
 * 也没有 `references/src`。两件事必须一起补——只补选中的话，存量模板在
 * Phase 4 落盘 `references/src/source.mp4` 时会 ENOENT，而新建模板一切正常，
 * 开发期用新模板自测百分百测不出来。
 *
 * 保证：目录布局与 Runtime Profile 选择，调用后一定都在。
 */
export function ensureWorkspaceLayout(dir: string): void {
  if (!existsSync(path.join(dir, PROFILE_FILENAME))) {
    throw new Error(`工作目录缺少 ${PROFILE_FILENAME}：${dir}`);
  }
  for (const rel of WORKSPACE_DIRS) mkdirSync(path.join(dir, ...rel), { recursive: true });
  ensureRuntimeSelected(dir);
}

/**
 * 确保这个工作目录选中了自己的 Runtime Profile。
 *
 * **为什么自己写文件而不是 spawn `hypit runtime use`**：这个契约是
 * `hypit runtime --help` 明写的——「Selection is read only from that project's
 * `.hypit/runtime`」，实测 `runtime use` 也只写两个文件：`.hypit/runtime` =
 * profile 文件名、`.hypit/.gitignore` = `*`，与这里的产出逐字节相同。
 * 而每次 spawn 要 2 秒，建模板是同步路径、单测里要跑二十多次，代价是把
 * 1.8 秒的套件拖成四十多秒，还让单测依赖 hypit 二进制在不在。
 *
 * 代价是 hypit 改了这个格式时这里会失效。**这条由 workspace.contract.test.ts
 * 钉住**：它用真 hypit 的 `doctor` 验我们写的选择还认不认，让失效变成一条红的
 * 测试，而不是用户导入视频那一刻的故障单。
 */
export function ensureRuntimeSelected(dir: string): void {
  // 已经选中就原样退出。不短路的话，启动迁移会在每次后端启动时给每个模板重写
  // 两个文件；将来挂到 transcribe 前面就是热路径上的重复写盘
  if (readSelection(dir) === PROFILE_FILENAME) return;

  const hypitDir = path.join(dir, ".hypit");
  mkdirSync(hypitDir, { recursive: true });
  // 这一份是 hypit 自己建的：执行状态目录不该进任何版本库
  writeFileSync(path.join(hypitDir, ".gitignore"), "*\n", "utf8");
  writeFileSync(selectionFile(dir), `${PROFILE_FILENAME}\n`, "utf8");
}

function readSelection(dir: string): string | undefined {
  const file = selectionFile(dir);
  if (!existsSync(file)) return undefined;
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    // 读不出来当作没选中，下一步会重写
    return undefined;
  }
}

/**
 * 重跑前清掉 Agent 在工作目录里写的东西（Spec REQ-003「重跑：清空 Agent 产物重新来」）。
 *
 * 留下的只有宿主建的：package.json、Runtime Profile 与它的选择（.hypit）、布局里的目录——
 * references（证据，重导要重新花时间转写）、productions（变体的数据）、assets（素材，可能有
 * 用户替换过的，宁可留着也不误删）。清单和布局用同一份常量，布局加了目录这里自动跟上。
 * 其余顶层条目（ANALYSIS.md、TIMELINE.md、reference.* 以及 Agent 自己建的任何文件）一律删。
 */
export function resetAgentProducts(dir: string): string[] {
  // 先验再删：传错目录（比如 workspaceOf 查错了）时一个文件都不能动
  // 比真实路径：工作目录里的 junction 指到外面时，字面判断会放行（Task 5.1 S1-M2 同一个坑）
  if (!isReallyInside(path.join(config.dataRoot, "clients"), path.resolve(dir))) {
    throw new Error(`不是模板工作目录，拒绝清理：${dir}`);
  }
  if (!existsSync(path.join(dir, PROFILE_FILENAME))) {
    throw new Error(`工作目录缺少 ${PROFILE_FILENAME}，拒绝清理：${dir}`);
  }
  const keep = new Set<string>(["package.json", PROFILE_FILENAME, ".hypit", ...WORKSPACE_DIRS.map((rel) => rel[0])]);
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (keep.has(name)) continue;
    rmSync(path.join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  ensureWorkspaceLayout(dir);
  return removed;
}

export function workspaceDir(clientId: string, templateId: string): string {
  return path.join(config.dataRoot, "clients", clientId, "templates", templateId);
}

/** npm 包名只允许小写字母、数字和 -._，这里把别的都换成 - */
function sanitizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return cleaned || "template";
}
