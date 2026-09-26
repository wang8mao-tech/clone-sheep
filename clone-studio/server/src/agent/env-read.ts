/**
 * 读凭据变量或整份导出环境的命令（REQ-010：key 只进 SDK 子进程）。Agent 有完整 Bash，`printenv` 一下
 * 就能把档案的 token 打进消息流、写进工作目录；消息流另有打码兜底（scheduler），这里先拦住。
 * 只拦「整份导出」与「点名凭据变量」：读单个普通变量（`$env:PATH`、`process.env.HOME`）照常放行（10.2 审查 S2-L3）。
 * 没用 Claude Code 的 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB：它会把权限模式强制改回 default（anthropics/claude-code#51258），
 * 无头会话里的每个工具调用都会卡在等人批准
 */
/** 点名凭据变量；`${!ANTHROPIC*}` 这种按前缀列变量名的间接展开也算（数组下标 `${!arr[@]}` 不算） */
const CREDENTIAL_VARS = /\b(ANTHROPIC_(AUTH_TOKEN|API_KEY)|CLAUDE_CODE_OAUTH_TOKEN)\b|\$\{!(?!\w+\[[@*]\]\})/i;
/** 命令位置：行首、分隔符之后、`$(` 里，或跟在 sudo / time / nohup / sh -c / cmd /c（Git Bash 写成 //c）后面 */
const AT_COMMAND = String.raw`(^|[;&|\x60]\s*|\$\(\s*|\b(sudo|time|nohup|command|exec|xargs|builtin)\s+|-c\s+["']?|\bcmd(\.exe)?\s+/{1,2}[ck]\s+["']?)(\S*[\\/])?`;
/** 命令结束：行尾、分隔符、重定向、收尾的引号 / 括号 */
const END = String.raw`\s*($|[;&|)\x60>"'}])`;
/**
 * 整份导出环境：env / printenv 只带选项（-0、-u NAME、--null…）、不跑别的命令也不点名；
 * set / export / export -p / declare -p|-x / typeset -p|-x / compgen -e 不带参数（`set -e` 是设开关，不算）
 */
const ENV_DUMP = new RegExp(
  `${AT_COMMAND}((env|printenv)(\\.exe)?(\\s+(-u\\s+\\S+|-C\\s+\\S+|--?[\\w-]+))*|(set|export(\\s+-p)?|declare\\s+-[px]+|typeset\\s+-[px]+|compgen\\s+-e)(\\.exe)?)${END}`,
  "im",
);
/** cmd 的 `set 前缀` 会列出所有以它开头的变量（`cmd /c set ANTH` 就把 key 列出来了） */
const CMD_SET = /\bcmd(\.exe)?\s+\/{1,2}[ck]\s+["']?\s*set(\s+[^\s=&|"']+)?\s*($|["'|&>])/i;
/**
 * 能列 / 读 Environment Provider 的命令（Get-Content 与 gc、cat、type 同样能读 env:），以及换进 env: 的命令
 * （换过去之后一个不带参数的 gci 就是整份导出，11.4 第四轮审查 S4-H1）
 */
const ENV_VERBS = String.raw`(Get-ChildItem|Get-Item|Get-Content|gci|gi|gc|dir|ls|cat|type|Set-Location|Push-Location|cd|sl|pushd|chdir)`;
/** 命令词只认命令位置：前面不是 `-`、字母、点、冒号（`-type f`、`rg --type`、`"type: env:"` 不算，S4-M3） */
const VERB_AT = String.raw`(?<![-\w.:])${ENV_VERBS}(?=[\s(]|$)`;
/**
 * 会把管道进来的字符串当路径用的命令（-Path 收管道值）：Get-Content / gc / cat / type 不收，`grep "env:" x | cat`
 * 只是看搜索结果（11.4 第六轮审查 S6-M1）
 */
const PIPE_PATH_VERB = String.raw`(?<![-\w.:])(Get-ChildItem|Get-Item|gci|gi|dir|ls|Set-Location|Push-Location|cd|sl|pushd|chdir)(?=[\s(]|$)`;
/** Provider 路径：`env:`，或 Provider 限定写法 `Environment::`、`Microsoft.PowerShell.Core\Environment::` */
const ENV_PATH = String.raw`(env:|(Microsoft\.PowerShell\.Core\\)?Environment::)`;
/**
 * 同一段里的参数：引号串整个算一个（里面的 ; | & 不分段），换行只在续行时跟过去——行尾反引号、逗号、左括号之后，
 * 或下一行缩进（`@( … )` 一行一个元素，S5-M1）；遇到 `<` 就停，heredoc 正文不是这个命令的参数（S4-M1、S4-M3）
 */
const SEGMENT = String.raw`("[^"]*"|'[^']*'|\x60\r?\n|[,(][ \t]*\r?\n|\r?\n[ \t]+|[^;|&\n"'<])*?`;
/**
 * 这些命令同一段里作为参数出现的 Provider 路径：跟在空白、逗号（数组）、括号、`@(`、冒号绑定（`-Path:env:`）后面，
 * 可带引号；`$env:X`、`${env:X}`、`./env:x` 不算。夹几个参数都一样（11.4 审查 S2-H1、R2-H1、R3-H1）
 */
const VERB_ENV = String.raw`${VERB_AT}${SEGMENT}([ \t,(@:]|(?<=[\x60,(])\r?\n)["']?${ENV_PATH}`;
/**
 * 整份或通配的路径（可带收尾的 `\`、`/`）经管道交给这些命令：路径在这一段哪里都算——前导空白、第二行、`{ }` 块里、
 * 数组 / 括号里、`echo env: | gci`（`'env:' | gci`、`"env:ANTH*" | Get-Item`；`'env:PATH' | gi` 与 `$env:`、`${env:}`、
 * `s/env:/` 不算；11.4 第五轮审查 S5-H1）
 */
const PIPED_ENV = String.raw`(?<![\w.:\\/-])["']?${ENV_PATH}([\\/]?(?=["'\s),|]|$)|[^\s"';|()]*[*?[][^\s"';|()]*)["']?("[^"]*"|'[^']*'|[^;|&\n"'])*?\|\s*${PIPE_PATH_VERB}`;
/** 各语言里整体读环境的写法（点名读单个变量的不算：`$env:PATH`、`env:PATH`、process.env.HOME、os.environ['PATH']） */
const ENV_READ = new RegExp(
  [
    // 整份导出：路径后面没有变量名（`gci env:`、`gci .,env:`、`gi ('env:')`、`gci Environment::`）
    String.raw`${VERB_ENV}(?![\w])`,
    // 按通配批量列（`gci env:ANTH*`、`gi env:ANTHROPIC_AUTH_TOKE[N]`）：和整份导出一样能把凭据变量列出来；
    // 扫到括号为止，`(gi env:PATH).Value[0]` 不算。grep / echo 里的 "env:" 字样不算（11.4 第三轮审查 R3-M1）
    String.raw`${VERB_ENV}[^\s"';|()]*[*?[]`,
    PIPED_ENV,
    String.raw`\[(System\.)?Environment\]::GetEnvironmentVariables`,
    String.raw`/proc/[^\s]*/environ`,
    String.raw`\bprocess\s*(\.\s*env\b|\[\s*["']env["']\s*\])(?!\s*[.[])`,
    String.raw`[)\]]\s*\.env\b(?!\s*[.[])`,
    String.raw`\bos\.environ\b(?!\s*(\[|\.get\())`,
    String.raw`\bSystem\.getenv\(\s*\)`,
    String.raw`%ENV\b`,
    String.raw`\bruby\b.*\bENV\b(?!\s*[[=.])`,
  ].join("|"),
  "i",
);

export function readsCredentialEnv(command: string): boolean {
  return CREDENTIAL_VARS.test(command) || ENV_DUMP.test(command) || CMD_SET.test(command) || ENV_READ.test(command);
}
