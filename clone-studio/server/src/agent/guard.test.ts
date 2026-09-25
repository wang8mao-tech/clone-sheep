import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgeToolCall } from "./guard.js";

/** DEV-PLAN Phase 5 验收：越界写路径、宿主敏感位置；命令扫描的写法表在 shell-scan.test.ts */

describe("judgeToolCall", () => {
  let base: string;
  let ws: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "cs-guard-"));
    ws = path.join(base, "ws");
    mkdirSync(ws);
  });

  afterEach(() => {
    const link = path.join(ws, "link");
    if (existsSync(link)) rmdirSync(link);
    rmSync(base, { recursive: true, force: true });
  });

  it("Bash 里的 build：拦，原因写明宿主负责、别换写法重试", () => {
    const d = judgeToolCall("Bash", { command: "hypit build a.svrun" }, { workspace: ws });
    expect(d?.rule).toBe("hypit-command");
    expect(d?.reason).toContain("出片与结果管理由宿主负责");
    expect(d?.reason).toContain("不要换写法重试");
  });

  it("任何带 command 字段的工具都按 shell 查（PowerShell 工具）", () => {
    expect(judgeToolCall("PowerShell", { command: "hypit build a.svrun" }, { workspace: ws })?.rule).toBe(
      "hypit-command",
    );
  });

  it("普通 Bash 放行", () => {
    expect(judgeToolCall("Bash", { command: "ls -la && hypit check a.svml" }, { workspace: ws })).toBeUndefined();
  });

  it.each(["Write", "Edit", "MultiEdit"])("%s 写到工作目录外：拦", (tool) => {
    const d = judgeToolCall(tool, { file_path: path.join(base, "OUTSIDE.txt") }, { workspace: ws });
    expect(d?.rule).toBe("write-outside-workspace");
  });

  it("NotebookEdit 用 notebook_path：越界同样拦", () => {
    expect(judgeToolCall("NotebookEdit", { notebook_path: path.join(base, "a.ipynb") }, { workspace: ws })?.rule).toBe(
      "write-outside-workspace",
    );
  });

  it("相对路径用 .. 爬出去：拦", () => {
    expect(judgeToolCall("Write", { file_path: "../escape.txt" }, { workspace: ws })?.rule).toBe(
      "write-outside-workspace",
    );
  });

  it("工作目录里的写（相对与绝对）：放行", () => {
    expect(judgeToolCall("Write", { file_path: "src/a.svml" }, { workspace: ws })).toBeUndefined();
    expect(judgeToolCall("Edit", { file_path: path.join(ws, "assets", "x.png") }, { workspace: ws })).toBeUndefined();
  });

  it("经 junction 指到外面、覆盖外面已有的文件：拦（比真实路径，字面上它在工作目录里）", () => {
    const outside = path.join(base, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "x");
    symlinkSync(outside, path.join(ws, "link"), "junction");
    const d = judgeToolCall("Write", { file_path: path.join(ws, "link", "secret.txt") }, { workspace: ws });
    expect(d?.rule).toBe("write-outside-workspace");
  });

  describe("宿主敏感位置（复审 S1-M2）", () => {
    const ctx = () => ({
      workspace: ws,
      secretsFile: path.join(base, "data", "secrets.json"),
      pluginDir: path.join(base, "data", "agent-plugin"),
      hypitRoot: path.join(base, "hypit-main"),
    });

    it("Bash 读密钥文件：拦", () => {
      const d = judgeToolCall("Bash", { command: `cat "${ctx().secretsFile}"` }, ctx());
      expect(d?.rule).toBe("protected-path");
    });

    it("PowerShell 用正斜杠写法读密钥文件：同样拦", () => {
      const p = ctx().secretsFile.replace(/\\/g, "/");
      expect(judgeToolCall("PowerShell", { command: `Get-Content ${p}` }, ctx())?.rule).toBe("protected-path");
    });

    it("Read / Grep 工具读密钥文件：拦", () => {
      expect(judgeToolCall("Read", { file_path: ctx().secretsFile }, ctx())?.rule).toBe("protected-path");
      expect(judgeToolCall("Grep", { pattern: "key", path: ctx().secretsFile }, ctx())?.rule).toBe("protected-path");
    });

    it("Bash 改插件目录里的 skill：拦（改了等于给之后每次会话下毒）", () => {
      const skill = path.join(ctx().pluginDir, "skills", "hypit", "SKILL.md");
      expect(judgeToolCall("Bash", { command: `echo evil > "${skill}"` }, ctx())?.rule).toBe("protected-path");
    });

    it("删改 hypit-main：拦；读 hypit-main 的文档：放行", () => {
      const root = ctx().hypitRoot;
      expect(judgeToolCall("Bash", { command: `rm -rf "${root}"` }, ctx())?.rule).toBe("protected-path");
      expect(judgeToolCall("PowerShell", { command: `Remove-Item -Recurse "${root}\\skills"` }, ctx())?.rule).toBe(
        "protected-path",
      );
      expect(judgeToolCall("Bash", { command: `cat "${root}/skills/hypit/SKILL.md"` }, ctx())).toBeUndefined();
    });

    it("运行 hypit-main 里的 hypit 并重定向输出：放行（复审 S1-H4：每条 check 都长这样）", () => {
      const cli = path.join(ctx().hypitRoot, "bin", "hypit.mjs");
      for (const command of [
        `node "${cli}" check reference.svrun --json 2>&1`,
        `node "${cli}" check reference.svrun --json > check.json`,
        `node "${cli}" check a.svml 2>/dev/null`,
        `node "${cli}" check a.svml 2>nul`,
        `cp "${ctx().hypitRoot}/examples/demo.svml" ./demo.svml`,
        `cat "${ctx().hypitRoot}/skills/hypit/SKILL.md" | tee notes.md`,
      ]) {
        expect(judgeToolCall("Bash", { command }, ctx()), command).toBeUndefined();
      }
    });

    it("写进 hypit-main：重定向、复制目标、移动、sed -i 都拦", () => {
      const root = ctx().hypitRoot;
      for (const command of [
        `echo x > "${root}/bin/hypit.mjs"`,
        `echo x >> "${root}/skills/hypit/SKILL.md"`,
        `cp evil.mjs "${root}/bin/hypit.mjs"`,
        `Copy-Item -Destination "${root}/bin" evil.mjs`,
        `mv "${root}/bin/hypit.mjs" ./x`,
        `sed -i s/a/b/ "${root}/bin/hypit.mjs"`,
      ]) {
        expect(judgeToolCall("Bash", { command }, ctx())?.rule, command).toBe("protected-path");
      }
    });

    it("前缀相同的兄弟目录不算插件目录（复审 S1-L5）", () => {
      const sibling = `${ctx().pluginDir}-old/notes.md`;
      expect(judgeToolCall("Bash", { command: `cat "${sibling}"` }, ctx())).toBeUndefined();
      expect(judgeToolCall("Bash", { command: `cat "${ctx().hypitRoot}-backup/x" > y` }, ctx())).toBeUndefined();
    });

    it("hypit 启动器目录：不许碰", () => {
      const binDir = path.join(base, "data", "agent-bin");
      const d = judgeToolCall("Bash", { command: `echo evil > "${binDir}/hypit"` }, { ...ctx(), binDir });
      expect(d?.rule).toBe("protected-path");
    });

    it("全局安装软件包：拦（hypit skill 会这么建议，宿主已把 hypit 放上 PATH）", () => {
      for (const command of ["npm install --global @hypit/hypit", "npm i -g @hypit/hypit", "pnpm add -g x"]) {
        expect(judgeToolCall("Bash", { command }, ctx())?.rule, command).toBe("protected-path");
      }
      expect(judgeToolCall("Bash", { command: "npm install" }, ctx())).toBeUndefined();
    });

    describe("密钥文件的变体读法（复审 S1-H5）", () => {
      beforeEach(() => {
        mkdirSync(path.join(base, "data"), { recursive: true });
        writeFileSync(ctx().secretsFile, "{}");
      });

      it("Grep / Glob 的搜索根是它的祖先目录：拦", () => {
        expect(judgeToolCall("Grep", { pattern: "apiKey", path: path.join(base, "data") }, ctx())?.rule).toBe(
          "protected-path",
        );
        expect(judgeToolCall("Grep", { pattern: "apiKey", path: "../../../.." }, ctx())?.rule).toBe("protected-path");
        expect(judgeToolCall("Glob", { pattern: "**/*.json", path: base }, ctx())?.rule).toBe("protected-path");
        expect(judgeToolCall("Glob", { pattern: "../data/*.json" }, ctx())?.rule).toBe("protected-path");
      });

      it("Glob 模式里带 .. 的一律拦：花括号、**/.. 这类前缀算不准（复审 S1-L9）", () => {
        expect(judgeToolCall("Glob", { pattern: "{../../../secrets.json,*.md}" }, ctx())?.rule).toBe("protected-path");
        expect(judgeToolCall("Glob", { pattern: "**/../../../*.json" }, ctx())?.rule).toBe("protected-path");
        expect(judgeToolCall("Grep", { pattern: "k", glob: "../*.json" }, ctx())?.rule).toBe("protected-path");
      });

      it.runIf(process.platform === "win32")("\\\\?\\ 前缀写法：拦", () => {
        expect(judgeToolCall("Read", { file_path: `\\\\?\\${ctx().secretsFile}` }, ctx())?.rule).toBe("protected-path");
      });

      it("Grep / Glob 在工作目录里：放行", () => {
        expect(judgeToolCall("Grep", { pattern: "x" }, ctx())).toBeUndefined();
        expect(judgeToolCall("Glob", { pattern: "**/*.svml" }, ctx())).toBeUndefined();
      });

      it("NTFS 数据流写法：拦", () => {
        expect(judgeToolCall("Read", { file_path: `${ctx().secretsFile}::$DATA` }, ctx())?.rule).toBe("protected-path");
        expect(judgeToolCall("Read", { file_path: `${ctx().secretsFile}:alt` }, ctx())?.rule).toBe("protected-path");
      });

      it.runIf(process.platform === "win32")("8.3 短名：Read 与 Bash 都拦", () => {
        const short = path.join(path.dirname(ctx().secretsFile), "SECRET~1.JSO");
        expect(judgeToolCall("Read", { file_path: short }, ctx())?.rule).toBe("protected-path");
        expect(judgeToolCall("Bash", { command: `cat ${short}` }, ctx())?.rule).toBe("protected-path");
      });

      it("Bash 里用文件名、相对路径提到它：拦", () => {
        expect(judgeToolCall("Bash", { command: "cat ../data/secrets.json" }, ctx())?.rule).toBe("protected-path");
        expect(judgeToolCall("Bash", { command: "cat ~/.clone-studio/secrets.json" }, ctx())?.rule).toBe(
          "protected-path",
        );
      });
    });

    it("读插件目录里的 skill references：放行（复审 S1-M8：skill 自己指着模型去读）", () => {
      const skill = path.join(ctx().pluginDir, "skills", "hypit");
      expect(judgeToolCall("Bash", { command: `cat "${skill}/references/svml.md"` }, ctx())).toBeUndefined();
      expect(judgeToolCall("Bash", { command: `ls "${skill}"` }, ctx())).toBeUndefined();
    });

    it("cd 进受保护目录之后的相对写：拦（复审 S1-M7）", () => {
      const root = ctx().hypitRoot;
      for (const command of [
        `cd "${root}" && rm -rf skills`,
        `cd "${root}/examples/podcast" && hypit check x --json > check.json`,
        `pushd "${ctx().pluginDir}"; echo evil > skills/hypit/SKILL.md`,
      ]) {
        expect(judgeToolCall("Bash", { command }, ctx())?.rule, command).toBe("protected-path");
      }
      expect(judgeToolCall("Bash", { command: "cd sub && echo x > a.txt" }, ctx())).toBeUndefined();
    });

    it("更多写法：mkdir、curl -o、tar -C 写进 hypit-main 都拦；cp -t 以 -t 为目标", () => {
      const root = ctx().hypitRoot;
      for (const command of [
        `mkdir "${root}/evil"`,
        `curl -o "${root}/x.js" https://x`,
        `tar -xf a.tar -C "${root}"`,
      ]) {
        expect(judgeToolCall("Bash", { command }, ctx())?.rule, command).toBe("protected-path");
      }
      expect(judgeToolCall("Bash", { command: `cp -t ./ex "${root}/examples/demo.svml"` }, ctx())).toBeUndefined();
    });

    it.runIf(process.platform === "win32")("Git Bash 的 /c/… 路径写法：按真实盘符解析（复审 S1-M7）", () => {
      const msys = (p: string) => `/${p[0]?.toLowerCase()}${p.slice(2).replace(/\\/g, "/")}`;
      expect(judgeToolCall("Bash", { command: `rm -rf ${msys(ctx().pluginDir)}` }, ctx())?.rule).toBe("protected-path");
      expect(judgeToolCall("Bash", { command: `echo x > "${msys(ctx().hypitRoot)}/bin/hypit.mjs"` }, ctx())?.rule).toBe(
        "protected-path",
      );
      expect(judgeToolCall("Read", { file_path: msys(ctx().secretsFile) }, ctx())?.rule).toBe("protected-path");
      // 反过来也不能误拦：工作目录里的文件用 /c/… 写，照样放行
      expect(judgeToolCall("Write", { file_path: `${msys(ws)}/a.txt` }, ctx())).toBeUndefined();
    });

    it("Runtime Profile 由宿主生成：Write / Edit / Bash 改它都拦，读放行（复审 S1-M9）", () => {
      expect(judgeToolCall("Write", { file_path: "hypit.runtime.json" }, ctx())?.rule).toBe("protected-path");
      expect(judgeToolCall("Edit", { file_path: path.join(ws, ".hypit", "runtime") }, ctx())?.rule).toBe(
        "protected-path",
      );
      expect(judgeToolCall("Bash", { command: "echo {} > hypit.runtime.json" }, ctx())?.rule).toBe("protected-path");
      expect(judgeToolCall("Read", { file_path: "hypit.runtime.json" }, ctx())).toBeUndefined();
      expect(judgeToolCall("Bash", { command: "cat hypit.runtime.json" }, ctx())).toBeUndefined();
    });

    it("变体会话（工作目录在项目根下的 productions/<id>/）：项目根那份 Runtime Profile 同样不许用 Bash 改（8.1 审查 MEDIUM-3）", () => {
      writeFileSync(path.join(ws, "package.json"), "{}");
      const sub = path.join(ws, "productions", "v1");
      mkdirSync(sub, { recursive: true });
      const sctx = { workspace: sub };
      for (const command of [
        "echo {} > ../../hypit.runtime.json",
        "cd ../.. && echo {} > hypit.runtime.json",
        "echo other > ../../.hypit/runtime",
        "echo {} > hypit.runtime.json",
      ]) {
        expect(judgeToolCall("Bash", { command }, sctx)?.rule, command).toBe("protected-path");
      }
      expect(judgeToolCall("Bash", { command: "cat ../../hypit.runtime.json" }, sctx)).toBeUndefined();
      expect(judgeToolCall("Bash", { command: "echo x > notes.md" }, sctx)).toBeUndefined();
    });

    it("全局安装的其他写法（复审 S1-L8）", () => {
      for (const command of ["npm install --location=global x", "npm -g install x"]) {
        expect(judgeToolCall("Bash", { command }, ctx())?.rule, command).toBe("protected-path");
      }
    });

    it("普通命令与读别的文件：放行", () => {
      expect(judgeToolCall("Bash", { command: "ls -la && cat ANALYSIS.md" }, ctx())).toBeUndefined();
      expect(judgeToolCall("Read", { file_path: "ANALYSIS.md" }, ctx())).toBeUndefined();
    });
  });

  it("读类工具不管路径", () => {
    expect(judgeToolCall("Read", { file_path: path.join(base, "anything.txt") }, { workspace: ws })).toBeUndefined();
  });

  it("入参畸形不抛", () => {
    expect(judgeToolCall("Bash", null, { workspace: ws })).toBeUndefined();
    expect(judgeToolCall("Write", { file_path: 42 }, { workspace: ws })).toBeUndefined();
  });
});

describe("凭据环境变量（REQ-010：key 只进 SDK 子进程）", () => {
  const ctx = { workspace: "C:/ws", pluginDir: "C:/plugin" };
  it("读凭据变量、整份导出环境：拦", async () => {
    const { judgeToolCall } = await import("./guard.js");
    for (const command of [
      "printenv",
      "env",
      "env | grep ANTH",
      "echo $ANTHROPIC_AUTH_TOKEN",
      "echo ${ANTHROPIC_API_KEY}",
      "printenv CLAUDE_CODE_OAUTH_TOKEN",
      "cd x && set",
      "export -p > vars.txt",
      "declare -x",
      "Get-ChildItem env:",
      "$env:ANTHROPIC_AUTH_TOKEN",
      'node -e "console.log(process.env)"',
      "python -c 'import os; print(os.environ)'",
      "cat /proc/self/environ",
      "x=$(env)",
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx)?.rule, command).toBe("protected-path");
    }
  });

  it("正常命令不误伤：env 设变量再跑、set -e、curl 找图、export 一个变量", async () => {
    const { judgeToolCall } = await import("./guard.js");
    for (const command of [
      "env NODE_OPTIONS= hypit check variant.svrun --json",
      "set -e; hypit check reference.svrun --json",
      'curl -L -A "Mozilla/5.0" "https://example.com/a.jpg" -o assets/a.jpg',
      "export FOO=1 && echo ok",
      "ls environment/",
      "cat .env.example",
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx), command).toBeUndefined();
    }
  });
});

describe("凭据环境变量：常见的绕法（10.2 审查 S2-M1）", () => {
  const ctx = { workspace: "C:/ws", pluginDir: "C:/plugin" };
  it("换个写法整份导出、点名读凭据：同样拦", async () => {
    const { judgeToolCall } = await import("./guard.js");
    for (const command of [
      "export",
      "declare -p",
      "compgen -e",
      "bash -c env",
      "sh -c 'env'",
      "sudo env",
      "time env",
      "nohup env > out.txt",
      "/usr/bin/env",
      "cmd /c set",
      "cmd.exe /c SET",
      "dir env:",
      "Get-Item Env:*",
      "[System.Environment]::GetEnvironmentVariables()",
      `node -e "console.log(require('process').env)"`,
      "perl -e 'print %ENV'",
      'ruby -e "p ENV"',
      "echo ${!ANTHROPIC*}",
      "v=ANTHROPIC_AUTH; v=${v}_TOKEN; echo ${!v}",
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx)?.rule, command).toBe("protected-path");
    }
  });

  it("点名读普通变量不拦（10.2 审查 S2-L3）", async () => {
    const { judgeToolCall } = await import("./guard.js");
    for (const command of [
      '$env:PATH = "$env:PATH;C:\\tools"; hypit check reference.svrun --json',
      'node -e "console.log(process.env.HOME)"',
      "python -c \"import os; print(os.environ['PATH'])\"",
      "python -c \"import os; print(os.environ.get('HOME'))\"",
      "docker run -e ENV=prod img",
      "curl https://example.com/env/list.json -o assets/list.json",
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx), command).toBeUndefined();
    }
  });
});

describe("Claude Code 的登录凭据文件（10.2 审查 S2-M2）", () => {
  const credentials = "C:/Users/me/.claude/.credentials.json";
  const ctx = { workspace: "C:/ws", pluginDir: "C:/plugin", credentialFiles: [credentials] };
  it("Read / Grep / 命令里碰它：拦", async () => {
    const { judgeToolCall } = await import("./guard.js");
    expect(judgeToolCall("Read", { file_path: credentials }, ctx)?.rule).toBe("protected-path");
    expect(judgeToolCall("Grep", { pattern: "token", path: "C:/Users/me/.claude" }, ctx)?.rule).toBe("protected-path");
    expect(judgeToolCall("Bash", { command: "cat ~/.claude/.credentials.json" }, ctx)?.rule).toBe("protected-path");
    expect(judgeToolCall("Bash", { command: `type "${credentials}"` }, ctx)?.rule).toBe("protected-path");
    expect(judgeToolCall("Read", { file_path: "C:/ws/SCRIPT.md" }, ctx)).toBeUndefined();
  });

  it("会话配置把两处凭据文件都交给 guard（默认 ~/.claude 与 CLAUDE_CONFIG_DIR）", async () => {
    const { claudeCredentialFiles } = await import("./session.js");
    const files = claudeCredentialFiles({ CLAUDE_CONFIG_DIR: "D:/cfg" });
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/[\\/]\.claude[\\/]\.credentials\.json$/);
    expect(files[1]!.replace(/\\/g, "/")).toBe("D:/cfg/.credentials.json");
  });
});

describe("凭据环境变量：第二轮审查列的写法（10.2 第二轮审查 S2-M1、S2-L1～L4）", () => {
  const ctx = {
    workspace: "C:/ws",
    pluginDir: "C:/plugin",
    credentialFiles: ["C:/Users/me/.claude/.credentials.json"],
  };
  it("带选项的导出、Git Bash 的 //c、带引号、cmd 的 set 前缀、PowerShell 的 -Path env:、按下标取 env：拦", async () => {
    const { judgeToolCall } = await import("./guard.js");
    for (const command of [
      "env -0",
      "env -u PATH",
      "printenv -0",
      "env --null",
      "/usr/bin/env -0",
      "env -0 | tr '\\0' '\\n'",
      "cmd //c set",
      "cmd //c env",
      'cmd /c "set"',
      'cmd /c "set | findstr ANTH"',
      "cmd /c set ANTH",
      "cmd /c set A",
      "Get-ChildItem -Path Env:",
      "gci -Path env:",
      "Get-Item -Path Env:*",
      "Get-ChildItem 'env:'",
      'gci "Env:"',
      "Set-Location env:; Get-ChildItem",
      `node -p "process['env']"`,
      `node -e "console.log(globalThis['process'].env)"`,
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx)?.rule, command).toBe("protected-path");
    }
  });

  it("读单个普通变量、按下标遍历数组、代码里的 set / env 字样、设变量跑命令：放行", async () => {
    const { judgeToolCall } = await import("./guard.js");
    for (const command of [
      "Get-Item env:PATH",
      "dir env:PATH",
      "gi env:HYPIT_STATE_HOME",
      "Get-ChildItem Env:PATH",
      "ls env:Path",
      'for i in "${!files[@]}"; do echo "$i"; done',
      "node -e \"const { set } = require('lodash'); console.log(set)\"",
      'node -e "[1].map((set) => set)"',
      'python -c "x=(env)"',
      "echo '{ env }'",
      "env FOO=1 node build.js",
      "set -e",
      "set -euo pipefail; hypit check variant.svrun --json",
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx), command).toBeUndefined();
    }
  });

  it("不点凭据文件名、改用通配或整目录去碰 ~/.claude：拦", async () => {
    const { judgeToolCall } = await import("./guard.js");
    for (const command of [
      "cat ~/.claude/.cred*",
      // 先 cd 进去（目录经变量拿到）再按文件名读：只能靠文件名认出来
      'D="$(dirname "$X")"; cd "$D" && cat .credentials.json',
      "cat ~/.claude/.credentials.jso?",
      "grep -r accessToken ~/.claude",
      "cp -r ~/.claude ./x",
      "gci -Force ~/.claude -Filter *.json | Get-Content",
      'ls "$HOME/.claude"',
      "type C:\\Users\\me\\.claude\\settings.json",
    ]) {
      expect(judgeToolCall("Bash", { command }, ctx)?.rule, command).toBe("protected-path");
    }
    for (const command of ["ls ./assets", "cat .claude-notes.md", "mkdir -p assets/.claudette"]) {
      expect(judgeToolCall("Bash", { command }, ctx), command).toBeUndefined();
    }
  });
});
