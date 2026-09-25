import { describe, expect, it } from "vitest";
import { judgeToolCall } from "./guard.js";

/** Phase 10 交接留下的两处拦截残余（Task 11.4）：PowerShell 按通配列环境变量、Git Bash 的 /c/Users 形式路径 */

const ctx = {
  workspace: "C:/ws",
  pluginDir: "C:/plugin",
  credentialFiles: ["C:/Users/me/.claude/.credentials.json", "C:/Users/me/.codex/auth.json"],
};
const denied = (command: string) => judgeToolCall("PowerShell", { command }, ctx)?.rule;

describe("PowerShell 按通配列环境变量（10.2 第二轮审查残余）", () => {
  it("env: 后面带 * 或 ? 就是在按名字批量列：拦", () => {
    for (const command of [
      "Get-ChildItem env:ANTH*",
      "gci env:*TOKEN*",
      "dir env:ANTHROPIC_?UTH*",
      "Get-Item -Path env:ANTH*",
      "ls 'env:A*'",
      "Get-ChildItem -LiteralPath env:*KEY*",
    ]) {
      expect(denied(command), command).toBe("protected-path");
    }
  });

  it("[...] 也是通配：把凭据变量名打断的写法同样拦（11.4 审查 S2-H1）", () => {
    for (const command of ["gi env:ANTHROPIC_AUTH_TOKE[N]", "Get-Item env:ANTHROPIC_AP[I]_KEY"]) {
      expect(denied(command), command).toBe("protected-path");
    }
  });

  it("Get-Content / gc / cat / type 读 env: 同样拦（11.4 审查 S2-H1）", () => {
    for (const command of ["gc env:ANTH*", "Get-Content env:*TOKEN*", "cat env:ANTH*", "type env:A*", "gc env:"]) {
      expect(denied(command), command).toBe("protected-path");
    }
  });

  it("动词和 env: 之间夹参数、冒号绑定同样拦（11.4 审查 S2-H1）", () => {
    for (const command of [
      "Get-Item -Force env:ANTH*",
      "gci -Path:env:ANTH*",
      "gci -Filter ANTH* -Path env:",
      "Get-ChildItem -ErrorAction SilentlyContinue env:*KEY*",
      'gci -Exclude "x y" env:ANTH*',
      'gci -Exclude "x y" env:',
    ]) {
      expect(denied(command), command).toBe("protected-path");
    }
  });

  it("不看动词：管道、括号、数组里的 env: 整份导出或通配同样拦（11.4 第二轮审查 R2-H1）", () => {
    for (const command of [
      "'env:' | gci",
      "'env:ANTH*' | gi",
      "'env:ANTHROPIC_AUTH_TOKE[N]' | gi",
      '"env:ANTH*" | Get-Item',
      "gi ('env:ANTH*')",
      "gi -Path ('env:ANTH*')",
      "gci -Path @('env:A*')",
      'Get-ChildItem "env:\\"',
    ]) {
      expect(denied(command), command).toBe("protected-path");
    }
  });

  it("数组元素里的 env:、Provider 限定写法 Environment:: 同样拦（11.4 第三轮审查 R3-H1）", () => {
    for (const command of [
      String.raw`gci C:\tmp,env:`,
      "gci .,env:",
      String.raw`gci C:\tmp , env:`,
      "gci Environment::",
      String.raw`gci Microsoft.PowerShell.Core\Environment::`,
      "gci Environment::ANTH*",
    ]) {
      expect(denied(command), command).toBe("protected-path");
    }
  });

  it("管道交给列目录命令：前导空白、第二行、块里、数组、echo、收尾斜杠都拦（11.4 第五轮审查 S5-H1、S5-M1）", () => {
    for (const command of [
      " 'env:' | gci",
      "Write-Host hi\n'env:' | gci",
      "Write-Host hi\n'env:ANTH*' | gi",
      "$null\r\n'env:' | Get-ChildItem",
      "{ 'env:' | gci }",
      "if ($true) { 'env:' | gci }",
      String.raw`'env:\' | gci`,
      "'env:/' | gci",
      "('env:') | gci",
      "@('env:') | gci",
      "'env:','x' | gci",
      "echo env: | gci",
      "Write-Output 'env:' | Get-ChildItem",
      String.raw`Get-ChildItem -Path @(` + "\n  'C:\\tmp'\n  'env:'\n)",
    ]) {
      expect(denied(command), command).toBe("protected-path");
    }
    for (const command of [
      "'env:PATH' | gi",
      "cat x.yml | grep 'env:'",
      "$env:PATH | Out-File p.txt",
      "sed 's/env:/x/' a | cat",
      "grep 'x/env:' a.txt | cat",
      "'./env:' | ls",
      "Write-Host 'env:'; $dirs | gci",
      'echo "env:"; git status | cat',
      // 搜索结果交给 cat / 分页不是读环境（11.4 第六轮审查 S6-M1、S6-L3）
      'grep -rn "env:" . | cat',
      "grep -c env: a.yml | cat",
      "git grep 'env:' | cat",
      "echo env: is a yaml key | cat",
      "Select-String -Path *.yml -Pattern 'env:' | gc",
    ]) {
      expect(denied(command), command).toBeUndefined();
    }
  });

  it("换目录进 env: 再列（11.4 第四轮审查 S4-H1）：拦", () => {
    for (const command of [
      "Set-Location -Path env:; gci",
      "sl -LiteralPath 'env:'; dir",
      "pushd env:; gci",
      "chdir env:; gci",
      "cd Environment::; ls",
      "cd env:",
    ]) {
      expect(denied(command), command).toBe("protected-path");
    }
  });

  it("续行、多行括号、引号里的 ; | & 不断开同一条命令（11.4 第四轮审查 S4-M1）：拦", () => {
    for (const command of [
      "gci `\n  env:ANTH*",
      "gci `\nenv:ANTH*",
      String.raw`gci C:\tmp,` + "\nenv:",
      "gci (\n'env:A*'\n)",
      "gci -Force `\n-Recurse env:",
      String.raw`gci C:\tmp,` + "\n" + String.raw`D:\x, env:`,
      "Get-ChildItem -Path `\r\n    env:",
      "gci (\n  'env:A*'\n)",
      String.raw`gci C:\tmp,` + "\n  env:",
      "gci -Exclude 'a;b' env:ANTH*",
      'gci -Filter "x|y" env:',
      "gci -Exclude 'a&b' env:",
    ]) {
      expect(denied(command), command).toBe("protected-path");
    }
  });

  it("-type 参数、heredoc 正文、模式串里的命令词不算（11.4 第四轮审查 S4-M3、S4-L2）：放行", () => {
    for (const command of [
      `find . -type f -name '*.yml' -exec grep -l "env:" {} +`,
      'rg --type yaml "env:"',
      "rg --type yaml 'env:' .",
      "cat > ci.yml <<'EOF'\nenv:\n  FOO: bar\nEOF",
      "cat > ci.yml <<EOF\nenv:\n  FOO: bar\nEOF",
      "cat > ci.yml <<'EOF'\njobs:\n  build:\n    env:\n      FOO: 1\nEOF",
      "cat > ci.yml <<'EOF'\n  env:\n    FOO: 1\nEOF",
      "ls\ngrep -n env: notes.md",
      'grep -rn "type: env:" docs',
      "cd ..",
      "cd env:PATH",
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx), command).toBeUndefined();
    }
  });

  it("搜索、写文件里的 env: 字样不是读环境：放行（11.4 第三轮审查 R3-M1）", () => {
    for (const command of [
      'grep -n "env:" .github/workflows/*.yml',
      "grep -rn 'env:' src",
      `rg "env:" -g '*.yml'`,
      'cat docker-compose.yml | grep -A3 "env:"',
      "Select-String -Path *.yml -Pattern 'env:'",
      'echo "env:" >> config.yml',
      "echo 'env:'",
      "grep -E 'env:[a-z]+' notes.md",
      'echo "value, env:foo*"',
      'Write-Output "env:*"',
      "'env:PATH' | gi",
      "Test-Path env:MY_VAR",
    ]) {
      expect(denied(command), command).toBeUndefined();
    }
  });

  it("点名读单个普通变量照常：$env:PATH、Get-Item env:PATH", () => {
    for (const command of [
      "$env:PATH",
      "Get-Item env:PATH",
      "echo $env:USERPROFILE",
      "gc env:PATH",
      "type env:USERPROFILE",
      "Get-Item -Force env:PATH",
      "cat file[1].txt",
      "gc ./notes.txt",
      "(gi env:PATH).Value[0]",
      String.raw`Get-Content .\frames\f[0-9].txt`,
      String.raw`ls "$env:TEMP\*.log"`,
      String.raw`dir ${"$"}{env:TEMP}\*.log`,
      "cat env.txt",
      "echo 'env: ok'",
    ]) {
      expect(denied(command), command).toBeUndefined();
    }
  });
});

describe("Git Bash 的 /c/Users 形式路径（10.2 第二轮审查残余）", () => {
  it("用 /c/Users/<名>/.claude 或 .codex 通配、整目录操作读凭据：拦", () => {
    for (const command of [
      "cat /c/Users/me/.claude/.cred*",
      "grep -r token /c/users/me/.claude/",
      "cp -r /c/Users/me/.claude ./x",
      "cat /c/Users/me/.codex/*",
      'tar czf a.tgz "/c/Users/me/.codex"',
      // Git Bash 继承的 $USERPROFILE、引号收在中间的 "$HOME"（11.4 第二轮审查 R2-M1）
      'cat "$USERPROFILE/.claude/x"',
      "cat ${USERPROFILE}/.claude/x",
      'cat "$HOME"/.claude/x',
      // Codex 的 ~/.codex 按家目录写法通配、整目录操作（11.4 第三轮审查 R3-H2）
      "cat ~/.codex/auth*",
      "cat ~/.codex/*",
      "cat $HOME/.codex/a*",
      "cp -r ~/.codex ./x",
      "grep -r token ~/.codex",
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx)?.rule, command).toBe("protected-path");
    }
    for (const command of [
      String.raw`gc ~\.codex\auth*`,
      String.raw`gc "$HOME\.codex\auth*"`,
      String.raw`type $env:USERPROFILE\.codex\au*`,
      // 11.4 第四轮审查 S4-M2
      String.raw`gc ${"$"}{env:USERPROFILE}\.codex\auth*`,
      String.raw`gc "$($HOME)\.codex\auth*"`,
      String.raw`gc $env:HOMEPATH\.codex\auth*`,
      String.raw`gc $env:HOMEDRIVE$env:HOMEPATH\.codex\auth*`,
      "cat $HOMEPATH/.codex/auth*",
      "cat ~//.codex/auth*",
      "cat ~/./.codex/auth*",
      // 先进家目录再用相对路径（11.4 第五轮审查 S5-M2）
      "cd ~; cat .codex/auth*",
      "cd ~ && cat .claude/.cred*",
      String.raw`Set-Location ~; gc .codex\au*`,
      "cd /c/Users/me && cat .codex/au*",
      "tar czf a.tgz -C ~ .codex",
      "cd $HOME; cat ./.claude/x",
      // 路径后面紧跟分隔符（11.4 第七轮审查 S7-M1）
      "cd ~/.codex; cat x",
      "cd $HOME/.claude&&ls",
      "ls ~/.codex|cat",
      "ls ~/.claude>files.txt",
    ]) {
      expect(denied(command), command).toBe("protected-path");
    }
  });

  it("别的盘、别的目录照常", () => {
    for (const command of [
      "ls /d/work/notes",
      "cat /c/Users/me/Documents/readme.txt",
      "echo /c/",
      "ls ~/.codex-notes",
      "cat ./proj/.codex/config.md",
      "cd ~/work && cat .codex/notes.md",
      "cat .claude/settings.json",
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx), command).toBeUndefined();
    }
  });
});
