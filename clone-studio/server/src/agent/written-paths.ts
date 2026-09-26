import path from "node:path";
import { resolveFrom } from "./guard-paths.js";
import { normalize, tokenize } from "./shell-scan.js";

/** 从一条 shell 命令里找出它会写的路径（guard 用来保护 hypit-main、插件目录与 Runtime Profile） */

/** 会改文件的命令：全部路径参数都算被写 */
const MUTATING_VERBS = new Set([
  "rm",
  "del",
  "erase",
  "rmdir",
  "rd",
  "remove-item",
  "ri",
  "mv",
  "move",
  "move-item",
  "mi",
  "set-content",
  "sc",
  "add-content",
  "ac",
  "out-file",
  "new-item",
  "ni",
  "clear-content",
  "tee",
  "tee-object",
  "touch",
  "truncate",
  "chmod",
  "mkdir",
  "md",
  "ln",
]);
/** 复制类只改目标：`cp <hypitRoot>/examples/x ./` 是正当的取示例 */
const COPY_VERBS = new Set(["cp", "copy", "copy-item", "cpi", "xcopy", "robocopy", "rsync"]);
/** 参数值是被写路径的选项：curl -o、wget -O / -P、tar -C、unzip -d */
const OUTPUT_FLAGS: Record<string, ReadonlySet<string>> = {
  curl: new Set(["-o", "--output"]),
  wget: new Set(["-O", "--output-document", "-P", "--directory-prefix"]),
  tar: new Set(["-C", "--directory"]),
  unzip: new Set(["-d"]),
};
const CD_VERBS = new Set(["cd", "set-location", "sl", "chdir"]);
/** 在当前目录里装包：hypit-main 缺依赖时 Agent 可能顺手 `cd hypit-main && pnpm install` */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const INSTALL_WORDS = new Set(["install", "i", "add", "ci", "update", "up", "remove", "rm", "uninstall"]);
/** 会改工作树的 git 子命令：作用于 -C 指定的目录或当前目录 */
const GIT_WRITES = new Set([
  "apply",
  "am",
  "checkout",
  "restore",
  "reset",
  "clean",
  "merge",
  "pull",
  "stash",
  "rebase",
]);

/**
 * 命令会写的路径（已解析成绝对路径）：重定向目标（不含 `2>&1` 这类转接）、改文件命令的
 * 全部路径参数、复制类的目标、curl -o 之类的输出选项；装包与改工作树的 git 子命令算写当前目录。
 * 相对路径按链上的 cd / pushd / popd 解析（SDK 模式下 Bash 的工作目录不跨调用保留，复审实测）。
 */
export function writtenPaths(command: string, workspace: string): string[] {
  const out: string[] = [];
  let base = workspace;
  let previous = workspace;
  const stack: string[] = [];
  const moveTo = (dir: string) => {
    previous = base;
    base = dir;
  };
  const redirect = /\d*>>?(?!&)\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g;
  for (const segment of normalize(command).split(/&&|\|\||[;\n]/)) {
    for (const m of segment.matchAll(redirect)) out.push(resolveFrom(base, unquote(m[1] as string)));
    for (const stage of segment.split("|")) {
      const tokens = tokenize(stage.replace(/\d*>>?&?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g, " ").replace(/[(){}]/g, " "));
      const verb = path.basename(tokens[0] ?? "").toLowerCase();
      const rest = tokens.slice(1);
      const positional = rest.filter((t) => !t.startsWith("-"));
      // 目录切换：cd（裸 cd 回家目录、cd - 回上一个）、pushd / popd
      if (CD_VERBS.has(verb)) {
        const to = rest.find((t) => t === "-" || !t.startsWith("-"));
        moveTo(to === "-" ? previous : resolveFrom(base, to ?? "~"));
        continue;
      }
      if (verb === "pushd" || verb === "push-location") {
        stack.push(base);
        moveTo(resolveFrom(base, positional[0] ?? "~"));
        continue;
      }
      if (verb === "popd" || verb === "pop-location") {
        moveTo(stack.pop() ?? base);
        continue;
      }
      const hits: string[] = [];
      const sedInPlace = verb === "sed" && rest.some((t) => /^-i/.test(t) || t === "--in-place");
      if (MUTATING_VERBS.has(verb) || sedInPlace) hits.push(...positional);
      if (COPY_VERBS.has(verb)) {
        const flag = rest.findIndex((t) => /^(-t|--target-directory|-dest(ination)?)$/i.test(t));
        const dest = flag >= 0 ? rest[flag + 1] : positional[positional.length - 1];
        if (dest) hits.push(dest);
      }
      const flags = OUTPUT_FLAGS[verb];
      if (flags) rest.forEach((t, i) => flags.has(t) && rest[i + 1] && hits.push(rest[i + 1] as string));
      if (verb === "dd") hits.push(...rest.filter((t) => t.startsWith("of=")).map((t) => t.slice(3)));
      if (PACKAGE_MANAGERS.has(verb) && rest.some((t) => INSTALL_WORDS.has(t))) {
        const dir = rest.findIndex((t) => t === "-C" || t === "--dir" || t === "--prefix");
        hits.push(dir >= 0 ? (rest[dir + 1] ?? ".") : ".");
      }
      if (verb === "git") {
        const dir = rest.findIndex((t) => t === "-C");
        const sub = rest.filter((t, i) => !t.startsWith("-") && rest[i - 1] !== "-C" && rest[i - 1] !== "-c")[0];
        if (sub && GIT_WRITES.has(sub)) hits.push(dir >= 0 ? (rest[dir + 1] ?? ".") : ".");
      }
      out.push(...hits.map((p) => resolveFrom(base, p)));
    }
  }
  return out;
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}
