import { describe, expect, it } from "vitest";
import { findDeniedHypit } from "./shell-scan.js";

/** DEV-PLAN Phase 5 验收：hypit build、node …/hypit.mjs build、PowerShell 与 bash 写法；两轮复审的绕过写法 */

describe("findDeniedHypit：花钱与改宿主状态的命令，任何写法", () => {
  it.each([
    ["裸命令", "hypit build demo.svrun"],
    ["带全局参数在前", "hypit --json build demo.svrun"],
    ["带取值参数在前", "hypit --workspace ./ws build demo.svrun"],
    ["node + 绝对路径（正斜杠）", 'node "C:/x/hypit-main/bin/hypit.mjs" build demo.svrun'],
    [
      "node.exe 带引号 + 反斜杠路径",
      '"C:\\Program Files\\nodejs\\node.exe" "X:\\w\\hypit-main\\bin\\hypit.mjs" build a.svrun',
    ],
    ["npx", "npx hypit build a.svrun"],
    ["pnpm exec", "pnpm exec hypit build a.svrun"],
    [".cmd 垫片", "hypit.cmd build a.svrun"],
    ["PowerShell 调用运算符", '& node "C:\\x\\hypit.mjs" build a.svrun'],
    ["PowerShell -Command 整段引号", 'powershell -NoProfile -Command "hypit build a.svrun"'],
    ["bash -c 单引号", "bash -c 'hypit build a.svrun'"],
    ["链在 && 后面", "cd ws && hypit check a.svml && hypit build a.svrun"],
    ["链在 ; 后面", "echo ok; hypit build a.svrun"],
    ["管道后面", "echo y | hypit build a.svrun"],
    ["命令替换里", "echo $(hypit build a.svrun)"],
    ["换行分隔的多行脚本", "hypit check a.svml\nhypit build a.svrun"],
    ["大写子命令", "hypit BUILD a.svrun"],
    // ── 复审 S1-H1：生产默认路径就带空格（X:\workflow\clone workflow\hypit-main），带引号时漏过 ──
    [
      "hypit 路径带空格且带引号（生产默认路径）",
      'node "X:/workflow/clone workflow/hypit-main/bin/hypit.mjs" build reference.svrun',
    ],
    ["node 与 hypit 路径都带空格", '"X:/my tools/node.exe" "X:/my tools/hypit-main/bin/hypit.mjs" build a.svrun'],
    // ── 复审 S1-M1：分隔符与续行 ──
    ["重定向紧贴", "hypit build>log.txt"],
    ["子 shell 括号", "(hypit build a.svrun)"],
    ["花括号分组", "{ hypit build a.svrun; }"],
    ["bash 续行", "hypit \\\n  build a.svrun"],
    ["PowerShell 续行", "hypit `\n  build a.svrun"],
    ["Start-Process 逗号参数", 'Start-Process node -ArgumentList "X:/x/hypit-main/bin/hypit.mjs","build"'],
    ["Start-Process -FilePath", "Start-Process -FilePath hypit -ArgumentList build,a.svrun"],
    ["node -e 里嵌套 execSync", `node -e "require('child_process').execSync('hypit build a.svrun')"`],
    ["绕过启动器直接跑 CLI 模块", "node X:/w/hypit-main/packages/video-cli/src/cli.ts build a.svrun"],
    ["环境变量前缀", "FOO=1 hypit build a.svrun"],
    ["cmd /c 带引号", 'cmd /c "hypit build a.svrun"'],
    // ── 复审 S1-M4：文本命令的输出喂给解释器 ──
    ["echo 管道给 bash", 'echo "hypit build a" | bash'],
    ["printf 管道给 sh", "printf 'hypit build a' | sh"],
    ["Write-Output 管道给 iex", 'Write-Output "hypit build a" | iex'],
    ["git log 管道给 sh", 'git log --format="hypit build a" -1 | sh'],
    // ── 复审 S1-M5：重定向与命令替换夹在参数中间 ──
    ["输入重定向夹在中间", "hypit <in.txt build a.svrun"],
    ["输出重定向夹在中间", "hypit >log.txt build a.svrun"],
    ["stderr 重定向夹在中间", "hypit 2>err.txt build a.svrun"],
    ["$() 在子命令前", "hypit $(true) build a.svrun"],
    ["反引号在子命令前", "hypit `true` build a.svrun"],
    ["PowerShell 括号表达式当子命令", "hypit (Write-Output build) a.svrun"],
    // ── 复审 S1-L3/L4：引号拼接、xargs ──
    ["单引号拼接", "h'y'pit build a.svrun"],
    ["空双引号拼接", 'hyp""it build a.svrun'],
    ["cmd /c 引号紧贴", 'cmd /c"hypit build a"'],
    ["git alias 执行 shell", "git -c alias.x='!hypit build a' x"],
    ["xargs 从管道拿子命令", "echo build | xargs hypit"],
    // ── 复审 S1-M6：带版本的 npx 包名、命令替换当命令本身 ──
    // ── 复审第四轮 S1-M10：Start-Process 单字符串参数与数组字面量 ──
    ["Start-Process -ArgumentList 单字符串", "Start-Process -FilePath hypit -ArgumentList 'build r.svrun' -Wait"],
    ["Start-Process 位置参数单字符串", "Start-Process hypit 'build r.svrun'"],
    ["Start-Process 双引号带更多参数", 'Start-Process hypit -ArgumentList "build r.svrun --json" -NoNewWindow -Wait'],
    [
      "powershell -Command 里的 Start-Process",
      `powershell -NoProfile -Command "Start-Process hypit -ArgumentList 'build r.svrun' -Wait"`,
    ],
    ["Start-Process 数组字面量", "Start-Process hypit -ArgumentList @('build','r.svrun')"],
    // ── 复审第四轮 S1-M11：内联 python / node 的列表写法 ──
    ["python subprocess 列表", `python -c "import subprocess; subprocess.run(['hypit', 'build', 'r.svrun'])"`],
    [
      "python heredoc subprocess 列表",
      "python3 <<'EOF'\nimport subprocess\nsubprocess.run(['hypit','build','r.svrun'])\nEOF",
    ],
    ["node execFileSync 列表", `node -e "require('child_process').execFileSync('hypit', ['build', 'r.svrun'])"`],
    [
      "node spawnSync 列表",
      `node -e "require('child_process').spawnSync('hypit',['build','r.svrun'],{stdio:'inherit'})"`,
    ],
    ["npx 带版本", "npx @hypit/hypit@0.2.6 build x"],
    ["npx -y latest", "npx -y hypit@latest build x"],
    ["$(which hypit) 当命令", "$(which hypit) build reference.svrun"],
    ["反引号 command -v", "`command -v hypit` build x"],
    ["引号里的命令替换当命令", '"$(command -v hypit)" build x'],
    // heredoc 喂给解释器：正文照常当命令查
    ["heredoc 喂给 bash", "bash <<'EOF'\nhypit build a.svrun\nEOF"],
    ["heredoc 经管道喂给 sh", "cat <<EOF | sh\nhypit build a.svrun\nEOF"],
  ])("%s", (_label, cmd) => {
    expect(findDeniedHypit(cmd)).toBeDefined();
  });

  it("命中时报出的就是被禁的子命令", () => {
    expect(findDeniedHypit("hypit BUILD a.svrun")).toBe("BUILD");
    expect(findDeniedHypit('node "X:/w/hypit-main/bin/hypit.mjs" --json build a')).toBe("build");
  });

  it.each([
    ["result finish", "hypit result finish b1", "result"],
    ["result edit", "hypit result edit b1 --title x", "result"],
    ["cancel", "hypit cancel b1", "cancel"],
    ["runtime use", "hypit runtime use ./p.json", "runtime use"],
    ["auth login", "hypit auth login", "auth login"],
    ["packages install", "hypit packages install a@1.0.0", "packages install"],
    ["programs up", "hypit programs up --endpoint whisperx.local", "programs up"],
    // 复审 S1-L1：往共享缓存装工具，和 packages install 同类
    ["capture install-browser", "hypit capture install-browser", "capture install-browser"],
    ["media prepare-fetch", "hypit media prepare-fetch", "media prepare-fetch"],
    // 复审 S1-L7：内部入口，等同 runtime up
    ["_worker", "hypit _worker --endpoint x", "_worker"],
  ])("改宿主状态：%s", (_label, cmd, expected) => {
    expect(findDeniedHypit(cmd)).toBe(expected);
  });

  it.each([
    ["check", "hypit check a.svml --json"],
    ["plan", "hypit plan a.svrun --json"],
    ["pricing", "hypit pricing a.svrun"],
    ["查询类", "hypit builds && hypit status b1 && hypit inspect b1"],
    ["本地工具 media", "hypit media probe a.mp4 --json"],
    ["transcribe", "hypit transcribe a.mp4 --to t.json --language zh"],
    ["runtime status", "hypit runtime status"],
    ["programs status", "hypit programs status"],
    ["文件名里带 build", "hypit check build.svml"],
    ["别的程序的 build", "npm run build && pnpm build"],
    ["单词里含 hypit", "cat hypit-notes.md && echo build"],
    ["echo 出来的文字", 'echo "run hypit later"'],
    // 复审 S1-L2：只处理文本的命令里出现这几个字，不是在执行它
    ["grep 找这句话", 'grep -rn "hypit build" .'],
    ["echo 进笔记", "echo 'hypit build' >> NOTES.md"],
    ["git 提交信息", 'git commit -m "docs: hypit build 由宿主负责"'],
    ["Select-String", 'Select-String -Pattern "hypit build" -Path *.md'],
    ["media fetch 取素材", "hypit media fetch https://x/y.jpg --to assets/y.jpg"],
    // 复审 S1-H4：check 的正常写法——合并 stderr、落 JSON 到文件
    ["check 合并 stderr", "hypit check reference.svrun --json 2>&1"],
    // 复审 S1-L6：常见写法里出现 build 这个词，不是在出片
    ["heredoc 写笔记", "cat > NOTES.md <<'XX'\nThe host will run hypit build later.\nXX"],
    ["Claude Code 惯用的 heredoc 提交信息", `git commit -m "$(cat <<'XX'\nfeat: ready for hypit build\nXX\n)"`],
    ["参数值叫 build", "hypit check reference.svrun --asset-root build"],
    ["Start-Process 跑 check", "Start-Process hypit -ArgumentList 'check r.svrun --json' -Wait"],
    // 复审第五轮 L-E：方括号当分隔符、数组字面量展开之后，这些日常写法仍要放行
    ["test 方括号", "[ -f r.svrun ] && hypit check r.svrun"],
    ["PowerShell 类型字面量", "[IO.File]::ReadAllText('r.svrun')"],
    ["jq 取下标", "hypit builds --json | jq .[0].id"],
    ["glob 字符集", "ls src/[a-z]*.svrun"],
    ["PowerShell 数组遍历跑 check", "foreach ($f in @('a.svrun','b.svrun')) { hypit check $f }"],
    ["python 列表跑 check", `python -c "import subprocess; subprocess.run(['hypit', 'check', 'r.svrun'])"`],
    ["git -C 提交", 'git -C . commit -m "prep for hypit build"'],
    ["grep 结果交给 xargs 数行数", "grep -rl 'hypit build' . | xargs wc -l"],
    ["check 落到文件", "hypit check reference.svrun --json > check.json"],
    ["echo 管道给非解释器", 'echo "hypit build" | tee NOTES.md'],
  ])("放行：%s", (_label, cmd) => {
    expect(findDeniedHypit(cmd)).toBeUndefined();
  });
});
