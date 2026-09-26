import path from "node:path";

/**
 * 在一条 shell 命令里找被禁的 hypit 调用（Spec REQ-003，guard.ts 的一半）。
 *
 * 威胁模型写在前面：这里拦的是模型的「常规写法」——hypit skill 教它的 `hypit build`
 * 及其常见变体（路径调用、带空格的引号路径、npx 带不带版本、PowerShell 的 `&` / Start-Process、
 * bash -c / node -e 嵌套、续行、重定向与命令替换夹在参数里、`$(which hypit)` 当命令、
 * 管道喂给解释器、引号拼接）。刻意混淆（变量拼接、base64、自写脚本再执行）字符串层面
 * 拦不全，也不假装拦得全：兜底是 Agent 进程环境里没有任何 key（session.ts 的放行名单）。
 */

/**
 * Agent 不许跑的 hypit 子命令。build 是唯一会花钱的；其余会改掉宿主管理的状态：
 * 结果记录、在跑的 Build、Runtime Profile 选择、凭据、全局包与共享缓存、托管程序。
 * 查询类（builds / status / inspect / logs / history）、check / plan / pricing、
 * 本地工具（media probe/fetch、transcribe、measure、snapshot）都放行——Agent 写稿要用。
 */
const DENIED_SUBCOMMANDS: Record<string, readonly string[] | "all"> = {
  build: "all",
  result: "all",
  cancel: "all",
  // 内部入口，等同 runtime up（hypit-main/packages/cli/src/arguments.ts）
  _worker: "all",
  auth: ["login", "logout"],
  packages: ["install"],
  runtime: ["init", "use", "unset", "up", "down"],
  programs: ["prepare", "up", "down"],
  capture: ["install-browser"],
  media: ["prepare-fetch"],
};

/** 这些全局参数后面跟一个值，找子命令时要连值一起跳过 */
const VALUE_FLAGS = new Set(["--workspace", "--runtime", "--color", "--registry", "--lines"]);

/** hypit 入口：裸命令、.mjs/.cmd/.ps1 垫片、任何以 hypit 结尾的路径、带版本的 npx 包名（`@hypit/hypit@latest`） */
const HYPIT_ENTRY = /(^|[\\/])hypit(\.mjs|\.cmd|\.ps1|\.js)?(@[^\\/\s]*)?$/i;
/** 绕开启动器直接跑 hypit-main 里的 CLI 模块（hypit.mjs 本身就是转调它） */
const HYPIT_MODULE = /[\\/]hypit-main[\\/].+\.(m?js|cjs|ts)$/i;

/**
 * 只处理文本、不会执行别的程序的命令：段首是它们、且没被管道喂给解释器时整段放行。
 * 不然 `grep -rn "hypit build" .`、`git commit -m "…hypit build…"` 都会被当成出片拦下。
 */
const TEXT_COMMANDS = new Set([
  "echo",
  "printf",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "findstr",
  "select-string",
  "sls",
  "write-output",
  "write-host",
]);
const SAFE_GIT = new Set(["commit", "log", "grep", "diff", "status", "show"]);

/**
 * 管道下游或 heredoc 的接收方若是它们，上游文本就是要执行的代码（`echo "hypit build" | bash`）。
 * xargs 不算：它的参数表照常扫描，`echo build | xargs hypit` 靠「管道目标没有子命令」拦。
 */
const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "pwsh",
  "powershell",
  "cmd",
  "iex",
  "invoke-expression",
  "node",
  "python",
  "python3",
  "source",
  ".",
]);

const SUBSTITUTION = "\u0000sub\u0000";
/** 里面提到了 hypit 的命令替换：`$(which hypit) build` 里它就是 hypit 本身 */
const HYPIT_SUBSTITUTION = "\u0000subh\u0000";

export function isHypitEntry(token: string): boolean {
  return token === HYPIT_SUBSTITUTION || HYPIT_ENTRY.test(token) || HYPIT_MODULE.test(token);
}

/** 返回被禁的「子命令 [动作]」，没有返回 undefined */
export function findDeniedHypit(command: string): string | undefined {
  const { outer, inner } = extractSubstitutions(stripHeredocs(normalize(command)));
  for (const nested of inner) {
    const hit = findDeniedHypit(nested);
    if (hit) return hit;
  }
  for (const group of outer.split(/&&|\|\||[;\n]|&(?!\d)/)) {
    const stages = group.split(/\|(?!\|)/).map((s) => dropEnvPrefix(tokenize(stripRedirects(s)).map(unpad)));
    const piped = stages.some((st, i) => i > 0 && INTERPRETERS.has(basename(st[0])));
    for (let s = 0; s < stages.length; s++) {
      const tokens = stages[s] as string[];
      if (isTextOnly(tokens)) {
        // 喂给解释器的文本就是代码：把它的参数当命令再查一遍
        if (piped) {
          for (const text of [tokens.slice(1).join(" "), ...tokens.slice(1).flatMap(nestedCandidates)]) {
            const hit = findDeniedHypit(text);
            if (hit) return hit;
          }
        }
        continue;
      }
      const hit = scanStage(tokens, s > 0);
      if (hit) return hit;
    }
  }
  return undefined;
}

function scanStage(tokens: readonly string[], isPipeTarget: boolean): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    // 引号里整段是一条命令：bash -c '…'、node -e "execSync('…')"、cmd /c "…"
    for (const text of /\s/.test(token) ? nestedCandidates(token) : []) {
      const nested = findDeniedHypit(text);
      if (nested) return nested;
    }
    // 带空格的引号路径本身也要当入口认（生产默认 X:\workflow\clone workflow\hypit-main\…）
    if (!isHypitEntry(token)) continue;
    const rest = tokens.slice(i + 1);
    // `hypit (Write-Output build) a`：子命令本身是算出来的，看不见就拒
    if (rest.find((t) => !t.startsWith("-")) === SUBSTITUTION) return "（子命令来自命令替换）";
    const [sub, action] = subcommandAfter(rest);
    if (!sub) {
      // `echo build | xargs hypit`：子命令来自管道输入，判断不了就拒
      if (isPipeTarget) return "（子命令来自管道）";
      continue;
    }
    const denied = DENIED_SUBCOMMANDS[sub.toLowerCase()];
    if (denied === "all") return sub;
    if (denied && action && denied.includes(action.toLowerCase())) return `${sub} ${action}`;
  }
  return undefined;
}

/**
 * 一个带空白的词里可能藏着的命令：原样；去掉 cmd 的 `/c` 前缀（`cmd /c"hypit build"` 分词后
 * 是 `/chypit build`）；去掉 `key=` 与 git 别名的 `!`（`alias.x='!hypit build'`、`--format=…`）。
 */
function nestedCandidates(token: string): string[] {
  return [token, token.replace(/^\/[a-z]/i, ""), token.replace(/^[^\s=]*=!?/, "")];
}

/** 续行拼回一行：bash 的 `\`+换行、PowerShell 的反引号+换行 */
export function normalize(command: string): string {
  return command.replace(/\\\r?\n/g, " ").replace(/`\r?\n/g, " ");
}

/**
 * 去掉 heredoc 正文：`cat > NOTES.md <<'EOF' … EOF` 与 Claude Code 惯用的
 * `git commit -m "$(cat <<'EOF' … EOF)"` 里的正文是文字，不是命令。正文喂给解释器
 * （`bash <<EOF`、`cat <<EOF | sh`）时保留，照常当命令查。
 */
function stripHeredocs(command: string): string {
  return command.replace(
    /^([^\n]*?)<<-?\s*(['"]?)([A-Za-z_][\w-]*)\2([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/gm,
    (whole, head: string, _quote: string, _tag: string, tail: string) => {
      const feedsInterpreter = `${head} ${tail}`
        .split(/\|(?!\|)|&&|;|\$\(|\(/)
        .some((segment) => INTERPRETERS.has(basename(tokenize(segment)[0])));
      return feedsInterpreter ? whole : `${head}${tail}`;
    },
  );
}

/**
 * 把 $(…)、反引号、(…) 抽出来单独查，原处换成占位符——它们的输出可能是子命令本身
 * （`hypit $(echo build)`），切段时不能把 hypit 的参数表切成两半。里面提到 hypit 的换成
 * 另一个占位符，外层把它当 hypit 入口（`$(which hypit) build`）。只处理不嵌套的一层，
 * 反复剥到没有为止。
 */
function extractSubstitutions(command: string): { outer: string; inner: string[] } {
  const inner: string[] = [];
  // PowerShell 数组字面量 @('build','x') 不是执行，是参数表本身：原地展开
  let outer = command.replace(/@\(([^()]*)\)/g, " $1 ");
  for (let guard = 0; guard < 20; guard++) {
    const next = outer.replace(/\$\(([^()]*)\)|`([^`]*)`|\(([^()]*)\)/g, (_m, a: string, b: string, c: string) => {
      const text = a ?? b ?? c;
      inner.push(text);
      return ` ${tokenize(text).some(isHypitEntry) ? HYPIT_SUBSTITUTION : SUBSTITUTION} `;
    });
    if (next === outer) break;
    outer = next;
  }
  return { outer, inner };
}

/** 引号里的占位符（`"$(command -v hypit)"`）分词后带着空格，去掉才认得出 */
function unpad(token: string): string {
  const t = token.trim();
  return t === SUBSTITUTION || t === HYPIT_SUBSTITUTION ? t : token;
}

/** 去掉重定向：`>log`、`2>&1`、`<in`、`>> out`——它们夹在参数中间会把子命令藏起来 */
function stripRedirects(segment: string): string {
  return segment.replace(/\d*(>>?|<)&?\s*("[^"]*"|'[^']*'|[^\s;&|]*)/g, " ");
}

function dropEnvPrefix(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] as string)) i++;
  if (tokens[i] === "env") i++;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] as string)) i++;
  return tokens.slice(i);
}

function isTextOnly(tokens: readonly string[]): boolean {
  const head = basename(tokens[0]);
  if (!head) return false;
  if (TEXT_COMMANDS.has(head)) return true;
  if (head !== "git") return false;
  // `git -C <dir> commit …` 照样是文字；`git -c alias.x='!…'` 能执行任意 shell，带 -c 的不放行
  let i = 1;
  while (tokens[i] === "-C") i += 2;
  return SAFE_GIT.has(tokens[i]?.toLowerCase() ?? "");
}

function basename(token: string | undefined): string {
  return token ? path.basename(token).toLowerCase() : "";
}

function subcommandAfter(rest: readonly string[]): [string | undefined, string | undefined] {
  let i = 0;
  while (i < rest.length) {
    const t = rest[i] as string;
    if (t.startsWith("-") || t === SUBSTITUTION) {
      i += VALUE_FLAGS.has(t) && !t.includes("=") ? 2 : 1;
      continue;
    }
    // `Start-Process hypit -ArgumentList 'build r.svrun'`：整串参数是一个词，拆开取前两个
    if (/\s/.test(t)) {
      const [first, second] = t.trim().split(/\s+/);
      return [first, second];
    }
    const next = rest.slice(i + 1).find((x) => !x.startsWith("-") && x !== SUBSTITUTION);
    return [t, next];
  }
  return [undefined, undefined];
}

/**
 * 分词：空白与逗号分隔，引号内原样保留，**相邻的引号段与裸段拼成一个词**——
 * `h'y'pit`、`hyp""it` 在 shell 里就是 hypit。逗号也分：PowerShell 的
 * `-ArgumentList "…/hypit.mjs","build"` 把参数用逗号连在一起。方括号也分：内联 python / node
 * 的列表写法 `subprocess.run(['hypit','build'])`、`execFileSync('hypit', ['build'])`。
 */
export function tokenize(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch) || ch === "," || ch === "[" || ch === "]") {
      if (has) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}
