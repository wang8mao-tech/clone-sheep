# Hypit 仓库调研报告（X:\workflow\clone workflow\hypit-main）

调研方式：只读。未修改任何文件。版本 `@hypit/hypit` **0.2.6**（`package.json:3`），`engines.node >= 22.15.0`（`package.json` 末尾 "engines"），`.node-version` = `24.14.1`，`packageManager: pnpm@10.33.0`。

---

## 0. 一句话结论（先给方向）

Hypit **不是**一个"输入 mp4 → 输出 workflow"的确定性流水线程序。它是一套 **给 Coding Agent 用的视频制作语言（SVML/SVS/SVRun）+ 确定性编译/执行 CLI**。"复刻"这一步是 **Agent（Claude Code / Codex）读 `skills/hypit/` 后手写 SVML** 完成的；CLI 只提供**证据工具**（下载、转写、抽帧、拼图）和**确定性构建/渲染**（plan / build / get / studio）。

因此 Web 封装层必须回答一个关键设计问题：**"复刻"这一步你要不要自己跑一个 Agent**。见文末第 9 节。

---

## 1. CLI：命令、参数、输出、JSON、退出码

### 1.1 入口链路

| 文件 | 行 | 作用 |
|---|---|---|
| `X:\workflow\clone workflow\hypit-main\hypit` | 1–11 | POSIX `sh` 启动脚本，`exec node "$launcher_dir/bin/hypit.mjs" "$@"`。**Windows 上这个脚本不可直接用**（需 Git Bash），直接 `node bin/hypit.mjs` 即可。 |
| `...\bin\hypit.mjs` | 1–46 | 真正入口。`register()` 挂 `tsx/esm/api`（**直接跑 TypeScript 源码，无需编译**），第 23–31 行 `installDistributionPackageResolution([distributionRoot])` + `installExternalPackageResolution([hypitHostPackageRoot()])`；第 33–46 行分流：`studio` → `packages/studio/start.ts#runStudio`，其它一律 → `packages/video-cli/src/cli.ts`。第 8–12 行单独处理 `--version`/`-v`（只打印版本后 `exit 0`）。 |
| `...\packages\video-cli\src\cli.ts` | 12–21, 64–100, 102–112 | 解析全局 `--json` / `--debug` / `--color <auto\|always\|never>` / `--no-color`；构造 `CliIo`（`write`→stdout，`writeProgress`→**stderr**，`setExitCode`）；help 路由；最后 catch → `renderCliError` → `process.exitCode = 1`。 |
| `...\packages\video-cli\src\index.ts` | 35–54 | `runVideoCli(argv, io, packages)`：`version` / creation(`transcribe`,`measure`) / `snapshot` / `media` / `capture` / `vocabulary` 走 video-cli 自己的实现，**其余全部转交 `@hypit/cli` 的 `runCli`**。 |
| `...\packages\cli\src\main.ts` | 60–653 | 通用引擎：`check` / `plan` / `pricing` / `build` / runtime / programs / packages / auth / results 等。 |

### 1.2 完整命令清单

**通用引擎命令**（帮助文本权威来源：`packages\cli\src\output.ts:996–1032`；参数解析：`packages\cli\src\arguments.ts:63–243`）：

*Authoring*
- `check <source>` — 校验一份 Author(.svml) 或 Run(.svrun) 源（`main.ts:279–345`）
- `plan <run-source>` — 只算计划、列出每个外部请求与 Provider，**不执行**（`main.ts:572–652`）
- `pricing <run-source>` — 读 Provider 当前价目（只读网络）
- `build <run-source> [--title <text>] [--follow] [--max-wait-ms <ms>] [--runtime <profile>] [--workspace <dir>] [--asset-root <dir>] [--package-root <dir>] [--limit <n>]` — **唯一真正提交工作的命令**（`main.ts:346–571`，`arguments.ts:103–120`）

*Results*
- `builds [--limit] [--before <build-id>]`
- `history <output-name>`
- `logs <build-id> [--lines <count>]`
- `status <build-id> [--watch] [--max-wait-ms]`
- `inspect <build-id> [--output <name>] [--limit]`
- `get <build-id> --output <name> --to <path>` — **导出成片的命令**（`arguments.ts:156–169`）
- `result edit|finish|discard <build-id>`（`--title`/`--note`/`--highlight`/`--clear-*`）

*Runtime / 环境*
- `doctor [profile] [--endpoint <instance>]`
- `runtime init [<profile>] | use <profile> | unset | up | status | logs | down`（`main.ts:125–181` 是 init/use/unset 的实现）
- `programs prepare|up|status|down [--endpoint <instance>]`
- `packages install|status <pkg@exact-version>`
- `activity [--watch] [--jsonl]`
- `cancel <build-id> [--reason <text>]`
- `paths`
- `auth status|login|logout <endpoint-instance> [--slot <name>] [--from <secret-file>]`

**video-cli 专有命令**（不经过 Runtime Build）：
- `version [--check] [--registry <url>] [--json]` — `packages\video-cli\src\version.ts:13–18`
- `transcribe <audio|video> --to <transcript.json> --language <code>` 与 `measure` — `creation.ts:30`（`creationCommands = ["transcribe","measure"]`）、帮助 `creation.ts:432–460`。**注意 transcribe 要走 Runtime Profile 的 whisperx-alignment Endpoint**（本地或 HypiHub）。
- `media probe|cut|frames|tile|tiles|boundaries|fetch|prepare-fetch` — `media.ts:20` 定义列表，帮助与全部参数在 `media.ts:814–837`。`media fetch <url> --to <video.mp4>` 就是 yt-dlp 下载。
- `capture screenshot|run|install-browser` — `capture.ts:8–47`（Puppeteer 截图/脚本录屏，支持 `record({path:'demo.mp4'})`）
- `snapshot --studio <url> | <index.html> --at-frame <n,…> --to <dir>` — `snapshot.ts:55–65`（**不产生 Build 就能抽帧预览**，可以直接对着运行中的 Studio 抽帧：`GET /__studio/document`）
- `vocabulary [<package…>] [--tag <t>] [--visual [<shape>]]` — `vocabulary.ts:321–333`，`--json` 输出所有已安装包/Surface 的机器视图

**Studio**（单独分流）：`hypit studio --run <build.svrun> [--runtime <p>] [--port <n>] [--workspace <d>] [--package-root <d>] [--locale-pack <f>]`，`packages\studio\start.ts:7–29`。

> **没有 `hypit init`（项目脚手架）、没有 `hypit render`、没有 `hypit serve`、没有 `hypit clone`。** `init` 只存在于 `runtime init`；渲染是 `build` 的一部分（`render:Video` 目标）；"serve" 只有 Studio。

### 1.3 JSON 输出与进度事件

- `--json`：几乎所有命令都支持。输出是带 `format` 字段的稳定机器视图，**全部 format 常量枚举在 `packages\cli\src\machine-view.ts:17–40`**：
  `hypit.cli-build@1`、`hypit.cli-plan@1`、`hypit.cli-check@1`、`hypit.cli-inspect@1`、`hypit.cli-get@1`、`hypit.cli-builds@1`、`hypit.cli-status@1`、`hypit.cli-activity@1`、`hypit.cli-logs@1`、`hypit.cli-paths@1`、`hypit.cli-runtime-*@1`、`hypit.cli-programs@1`、`hypit.cli-auth-*@1`、`hypit.cli-doctor@1`、`hypit.cli-version@1`。
  错误也是 JSON：`hypit.cli-error@1`（`output.ts:1046–1057`，字段 `{ok:false, error:{code,message,help?,trace?}}`）。
- **进度事件**：`build --follow` 的进度走 `io.writeProgress` → **stderr**（`cli.ts:53`），文本行由 `packages\cli\src\observation.ts:92 buildProgressLines` 生成；结构体类型是 `BuildProgressView`（`observation.ts:13–20`：`{build, state: "submitting"|"working"|"saving-result", requests:{total,completed}, phases, elapsedMs, details[]}`）。`main.ts:452–466` 把它挂到 `observeBuild`。
  → **用 `--json` 时，stdout 只有最终一份 JSON，进度在 stderr**。这是 Web 层做实时进度条的抓手。
- **唯一的真·流式 JSON**：`hypit activity --watch --jsonl`（`arguments.ts:193–198`，`output.ts:768` 用 `JSON.stringify(...,0)` 单行输出）。注意：`activity --watch` 拒绝 `--json`，必须 `--jsonl`。
- 进度节流常量：`observation.ts:8–11`（首次心跳 30s，之后 60s，进度最小间隔 5s）。

### 1.4 退出码

**只有 0 和 1**（`grep setExitCode` 全仓结果）：
- `main.ts:565` build 失败/需要人工介入 → 1；`main.ts:649` plan 有未解析/不支持的请求或 preflight 失败 → 1
- `commands\execution.ts:106,141,160,311,337,357,388`、`commands\environment.ts:143,170,235,281,309` → 1
- `version.ts:70`（`--check` 查询失败）→ 1
- `cli.ts:111` / `bin\hypit.mjs:43` 顶层异常 → 1

### 1.5 输出目录结构

- 项目状态根：`<project>/.hypit`（`packages\cli\src\paths.ts:5–7`）
- Runtime 数据：Profile 里的 `dataRoot`，默认 `.hypit/runtimes/local`（`packages\video-cli\src\distribution.ts:28`）
- **Build Result 仓库**：默认 `.hypit/results`，按 UTC 日期分桶：
  `.hypit/results/<YYYY-MM-DD>/<build-id>/`，内含 `result.json` + 新产出的资源文件 + Composite Value Document（`packages\build-result-fs\README.md:4, 13, 22`），另有 `execution.jsonl`（`packages\build-result\README.md` "Execution evidence" 段）
- **成片 mp4 不会自动出现在 output/**：必须显式 `hypit get <build-id> --output final.video --to output/final.mp4`（`docs\zh\quickstart\run.md:19–21`）。`hypit get --json` 返回 `hypit.cli-get@1 { build, output, type, kind, path }`（`machine-view.ts:34`）。
- 机器级状态根：`HYPIT_STATE_HOME` 或 Windows `%LOCALAPPDATA%\Hypit`（`packages\runtime-host-node\src\index.ts:326–347`），下面有 `programs/`（uv venv、Chromium 缓存）、`packages/`（`hypit packages install` 装的 pinned npm 包）。

---

## 2. "复刻(clone)"到底是谁做的 —— **完全是 Coding Agent**

### 2.1 证据

- `skills\hypit\SKILL.md:1–4` frontmatter：`name: hypit`，描述 "Direct and produce videos with Hypit… includes SVML/SVS/SVRun authoring and Runtime or credential setup."
- `SKILL.md:8–20` 直接对 Agent 说话："**You are the director and producer entrusted with making the video**… When a reference is supplied, **watch it, inspect its frames and read any speech in time**."
- `SKILL.md:147–177`（"Understand and adapt"）：要求 Agent 把整片理解写进 `ANALYSIS.md`、把逐时刻细节写进 `TIMELINE.md`。
- `SKILL.md:257–321` 是一张巨大的"什么问题去读哪个 reference"路由表（60+ 行），Agent 按需加载 `references/production/*.md`、`references/playbooks/craft/*.md`。
- `.claude\skills\hypit` 和 `.codex\skills\hypit` 都是 **0 字节文件**（在 Windows 检出里是未解析的 git symlink），指向 `skills/hypit/`。`.gitignore` 第 14–20 行明确写："the skill itself is a repository source at `skills/hypit`; what lives here is only the per-agent link"。
- `skills\hypit\agents\openai.yaml`（4 行）给 Codex 侧的展示名与默认 prompt：`"Use $hypit to make or revise the video from my brief and any supplied references."`
- `README.zh-CN.md:129–137`：使用方式就是在 Agent 会话里输入 `/hypit 复刻这个视频：/path/to/video.mp4，…`
- `docs\zh\quickstart.md:9–12`："你需要准备：支持 Skill 的 Coding Agent，例如 Claude Code 或 Codex。"

### 2.2 一条 mp4 → `reference.svml` 的每一步，谁执行

权威文档：`skills\hypit\references\creation\reference-video.md`（245 行，全文已读）。

| 步骤 | 执行者 | 具体命令/包 | 证据 |
|---|---|---|---|
| 0. 链接 → 本地 mp4 | **CLI（确定性）** | `hypit media prepare-fetch` → `hypit media fetch <url> --to references/ad/source.mp4`；底层 `@hypit/yt-dlp` + `services/yt-dlp`（uv 锁定的 yt-dlp） | `reference-video.md:6–8, 101`；`packages\yt-dlp\src\environment.ts:9–13, 28–34` |
| 1. 探测 | **CLI** | `hypit media probe` | `reference-video.md:96` |
| 2. 逐词转写+对齐 | **CLI → Provider** | `hypit transcribe <mp4> --language zh --to transcript.json`，走 Profile 里绑定的 `@hypit/whisperx@1#whisperx-alignment`（本地 `provider-whisperx-local` 或托管 HypiHub） | `reference-video.md:70–84`；`creation.ts:434–447` |
| 3. 抽帧/时间标注拼图 | **CLI** | `hypit media frames/tile/tiles --transcript transcript.json --around "短语" --every-frame …` | `reference-video.md:94–152`（含完整示例命令块 108–112、135–152） |
| 4. **看懂并解释整片** | **Agent（人类级判断）** | 无命令。Agent 用多模态读取上面产出的 jpg/png/mp4/transcript，写出 `ANALYSIS.md` + `TIMELINE.md` | `reference-video.md:10–66, 172–198`（甚至给了 TIMELINE.md 的写法示例 188–198） |
| 5. 定目标与变体 | **Agent + 用户** | 写 `BRIEF.md` / `TREATMENT.md` | `references\creation\brief.md`、`transformations.md` |
| 6. **手写 `.svml` / `.svs` / `.svrun`** | **Agent** | 依据 `hypit vocabulary <pkg> --json` 拿到 Surface 词表 + `references/production/*.md` 语法页，逐行写 XML | `SKILL.md:289–292` 行的路由表指向 `production/authoring.md`、`source-syntax.md`、`runs.md`；`vocabulary.ts:321–333` |
| 7. 校验 / 估价 | **CLI** | `hypit check`、`hypit plan`、`hypit pricing` | `output.ts:996–1003` |
| 8. 生成素材 + 渲染成片 | **CLI + Runtime** | `hypit build build.svrun --follow`（内部：Core 规划 → Worker 执行 → 各 Provider 生成图/视频/语音 → `render-hyperframes` 用无头 Chromium 渲染 → ffmpeg 编码 mp4） | `main.ts:346–571`；`packages\provider-hyperframes-local\README.md:1–10` |
| 9. 导出 | **CLI** | `hypit get <build-id> --output final.video --to output/final.mp4` | `docs\zh\quickstart\run.md:21` |
| 10. 审片/改 | **Agent + Studio** | `hypit snapshot`、`hypit studio --run` | `SKILL.md:186–203` |

> **关键：第 4 步和第 6 步没有任何程序可以替你做。** 仓库里不存在"parse mp4 → emit svml"的代码路径。`grep` 全仓无 `clone` 命令。

### 2.3 项目目录约定（Agent 会创建的）

`skills\hypit\references\creation\project-files.md:88–110`：
```
project/
├── references/<reference>/{source.*, ANALYSIS.md, TIMELINE.md, transcript.json, evidence/, PROGRESS.md}
├── productions/<target>/{BRIEF.md, TREATMENT.md, PROGRESS.md, authors/, recipes/, runs/, assets/}
├── assets/  packages/  hypit.runtime.json  package.json
```
`project-files.md:41–56`：**CLI 用"命令工作目录往上最近的 `package.json`"作为项目根**，或用 `--workspace` 显式指定。这对 Web 后端很重要：每个用户任务开一个目录 + 一个最小 `package.json` 就是一个独立项目。

---

## 3. 现成的 Web UI / HTTP 服务

### 3.1 `packages/studio` —— **唯一的本地 HTTP 服务，是"预览 + 轻编辑器"**

- 启动：`hypit studio --run <build.svrun>`（`packages\studio\start.ts:51–174`）
- **本质是一个 Vite dev server**（`start.ts:146–165`，`createServer({configFile:false, root: here, server:{port, fs:{allow:[...]}}})`），**默认端口 5179**（`start.ts:109`），`--port` 可改。
- 启动时打印 Project / Run / Runtime Profile / 浏览器 URL / Comments URL（`start.ts:100–108, 172–173`）。
- HTTP 路由（`packages\studio\src\server.ts`，均在 vite 中间件里）：

| 方法 | 路径 | 行号 | 说明 |
|---|---|---|---|
| PUT | `/__studio/source` | 480 | 回写选中的 Source 文件 |
| PUT | `/__studio/artifact-name` | 535 | 改 Output 显示名 |
| POST | `/__studio/mutation` | 561 | 时间轴/参数编辑 |
| GET | `/__studio/visual.html` | 600 | **当前合成画面的纯 HTML（无播放器 shim、无音频）** |
| GET | `/__studio/document` | 600/611 | **当前编译出的 `HyperframesDocument` JSON** |
| GET | `/__studio/session` | 622 | 会话信息 |
| GET | `/__studio/library` | 638 | Source / Tasks（Build 列表）/ Artifacts（媒体） |
| GET | `/__studio/surface-preview` | 659 | 组件预览 |
| GET | `/__studio/storyboard/<res_…>` | 683 | 故事板资源 |
| GET | `/__studio/material/<res_…>` | 717 | **素材文件字节（图/视频/音频）** |
| GET | `/__studio/artifact` | 733 | Output 产物 |
| GET/POST | `/__studio/feedback` | `feedback-server.ts:26–56` | 时间戳评论，落 `FEEDBACK.json` |

- **安全限制（对 Web 封装很关键）**：所有 **POST/PUT 写操作**都要过 `allowsStudioMutation`（`packages\studio\src\mutation-origin.ts:3–20`）：`Host` 头必须是 `localhost`/`127.0.0.1`/`[::1]`，`Origin` 必须同源，`sec-fetch-site` 必须是 `same-origin`/`none`。→ **你可以反代 GET（预览/抽帧/素材），但不能简单反代写操作**（需要重写 Host/Origin 头，属于绕过其设计）。GET 路由本身没有这个限制。
- Studio README（`packages\studio\README.md:1–10`）说明 `hypit snapshot --studio <url>` 就是靠 `GET /__studio/document` + `/__studio/material/<res>` 工作的 → **Web 层可以复用这条路做"不跑 Build 的秒级预览"**。

### 3.2 其它同名包**不是** HTTP 服务

- `*-studio`（`audio-track-studio`、`caption-fine-studio`、`film-studio`、`performance-studio`、`ranking-studio`、`script-studio`、`sound-studio`、`media-track-studio`、`deck-track-studio`、`typography-track-studio`、`comment-sticker-studio`、`screen-overlay-studio`）= **Studio 的"组件伴侣"（companion）**，给每个组件在时间轴上提供实体/参数/选帧能力。见 `docs\guide\studio-companion-architecture.md`、`packages\video-cli\src\studio-distribution.ts`（`videoStudioCompanionPackages`）。
- `packages/host` = 不透明的 `HostFacet` 信封（包加载协议），**与 web host 无关**（`packages\host\README.md:1–5`）。
- `packages/endpoint-kit` = 写 Provider 包的公开 SDK（`defineEndpointPackage`、`AsyncEndpoint` 的 `start/poll/cancel`、`context.reportProgress`）。`packages\endpoint-kit\README.md:1–46`。
- `packages/runtime-host-node` = Node 侧 Runtime Host 抽象（`createRuntime`、`controller`、`runWorker`、`hypitHostStateRoot`/`hypitHostPackageRoot`）。
- `packages/transport-aws-lambda` = 给 Provider 用的 Lambda 同步 JSON 调用传输层，**"deliberately not an Endpoint and declares no SVML capability"**（README:1–6）。不是给你部署 Hypit 用的。
- `packages/protocol` = 值/类型/Schema/BuildId 的底层协议。

**结论：仓库里没有任何面向公网的 HTTP API / 任务队列 / 多租户服务。Studio 是单 Run、单进程、localhost-only 的开发服务器。**

---

## 4. 可嵌入的程序化 API

### 4.1 公开 `exports`（npm 包对外暴露的）

根 `package.json:11–108` 的 `exports` 只有 **24 个作者向/Provider 向子路径**：
`./browser-capture ./artifact ./author-kit ./caption ./composition ./endpoint-kit ./generation ./media ./model-kit ./narrative ./program-space ./runtime-kit ./timeline ./spatial ./speech ./studio-adapter ./svs ./temporal ./temporal-markup ./text ./visual-ir ./hyperframes ./performance ./sound`

→ **`cli` / `video-cli` / `core` / `run` / `runtime-local` / `driver-node` / `compiler-node` / `workspace` / `studio` 统统不在公开 exports 里**，而且它们的 `package.json` 都是 `"private": true`（例如 `packages\core\package.json`、`packages\run\package.json`、`packages\runtime-local\package.json`、`packages\compiler-node\package.json`、`packages\workspace\package.json` 全部 `private: true`）。

### 4.2 但是 —— **Distribution 解析钩子让你可以 import 任意内部包**

`packages\package-loader-node\src\distribution-resolution.ts:1–50` + `location.ts:180–219`：
- `installDistributionPackageResolution([distributionRoot])` 注册 `node:module` 的 `registerHooks`，把任何 `@hypit/<name>` 裸标识符解析到 `<distributionRoot>/packages/<name>/` 的 `package.json.exports`，**完全不依赖 node_modules**（`location.ts:180–191 distributionPackageDirectory`，还会 fallback 扫 `services/`）。
- 这正是 `bin\hypit.mjs:25–32` 做的事。

**⇒ 可行的嵌入方式**（与 CLI 完全等价）：
```js
import { register } from "tsx/esm/api";
register();
const { installDistributionPackageResolution, installExternalPackageResolution } =
  await import(`${dist}/packages/package-loader-node/src/distribution-resolution.ts`);
installDistributionPackageResolution([dist]);
const { hypitHostPackageRoot } = await import(`${dist}/packages/runtime-host-node/src/index.ts`);
installExternalPackageResolution([hypitHostPackageRoot()]);
const { runVideoCli } = await import("@hypit/video-cli");
await runVideoCli(["build", "build.svrun", "--follow", "--json"], myCliIo);
```
`CliIo` 接口在 `packages\cli\src\output.ts:14–25`：`{write, writeProgress?, setExitCode?, readSecret?, terminal?}` → **你可以把 stdout/进度直接接到 SSE/WebSocket，不需要 spawn 子进程解析文本**。这是"进程内驱动"的最佳折中。

### 4.3 有没有 `build(project)` 这样的函数？

**没有单一的高层函数。** 最接近的分层：

| 层 | 符号 | 位置 |
|---|---|---|
| 顶层（等价于 CLI） | `runVideoCli(argv, io, packages?)` | `packages\video-cli\src\index.ts:35` |
| 通用引擎 | `runCli(argv, io, distribution)` | `packages\cli\src\index.ts:1` → `main.ts:60` |
| 装配描述 | `videoCliDistribution: CliDistribution` | `packages\video-cli\src\distribution.ts:22–84`（含 `initialRuntimeProfile`、`createCompiler`、`openRuntimeHost`、`openProjectResults`） |
| 编译器 | `createVideoCompiler(options)` / `createVideoWorkspace(options)` | `packages\video-cli\src\compiler.ts:6, 28` |
| Run 装载 | `loadRunFile` / `checkRunFile` / `collectRunFrontends` / `resolveBuildResultValue` | `packages\cli\src\index.ts:4`，实现 `packages\cli\src\run-file.ts` |
| Runtime | `openLocalRuntimeHost` / `createLocalRuntime` / `openProjectBuildResultRepository` / `doctorRuntimeConfig` / `readRuntimeConfigPricing` / `preflightRuntimeConfig` … | `packages\runtime-local\src\index.ts:1–37` |
| **真正提交 Build** | `runtime.build(request)`，`request` 形如 `{id, definition, componentPackages, catalog, attachments, result:{repository,title,resourceReferences,forwards}}` | `packages\cli\src\main.ts:384–426` |
| Core | `compileBuild` / `planBuild` / `plannedNeeds` / `defineBuild` / `materializeBuild` / `BuildMachine` | `packages\core\src\index.ts:22, 25–31` |

**手写一条 build 流程的最短路径**（照抄 `main.ts:346–426`）：
`projectResults()` → `loadRunFile()` → `compiler.planCompilation()` → `runtimeHost()` → `controller.worker.up()` → `evaluatePlanNeeds` / `describePlanProviders` / `preflightPlan` → `runtime.build(request)` → `observeBuild()` → `buildResults.repository.read(id)`。**约 200 行、有 6 个内部包的类型依赖**，不推荐重写。

### 4.4 build-result / artifact 结构

- 机器视图类型：`packages\cli\src\view.ts:16–24`（`CliOutputView = {name, type, kind: "scalar"|"resource"|"composite", target, highlighted, mediaType?, size?}`）、`view.ts:38–60`（`CliBuildResultView`：`{id,title?,note?,createdAt,finishedAt?,outcome:"open"|"complete"|"failed"|"cancelled",source,run?,targets[],outputs[],failure?,operations[],executionLog?}`）。
- 值的持久化规则表：`packages\build-result\README.md`（"Values and file ownership"）：新资源 → 本 Build 自有文件；Workspace 文件 → `external-file` + URI；旧 Result 的资源 → `build-file` + `{build,path}`；整个旧 Output → `build-output`。
- 落盘：`.hypit/results/<date>/<build-id>/result.json` + 媒体文件 + `execution.jsonl`（`packages\build-result-fs\README.md:22`）。
- 另有 S3 后端 `@hypit/build-result-s3` 与 `@hypit/resource-store-s3` —— **Web 服务化时可以把 Result 仓库直接指向 S3**（通过项目根的 `hypit.results.json`，见 `build-result-fs/README.md:8–15` 的选择文件格式）。

### 4.5 成片 mp4 到底在哪

1. Build 完成后它在 `.hypit/results/<date>/<build-id>/` 里（文件名由 Result 分配）。
2. 稳定拿到它的方式：`hypit get <build-id> --output final.video --to <path>`；`--json` 返回 `{format:"hypit.cli-get@1", path}`。
3. 或者 `hypit inspect <build-id> --json` 拿 `outputs[]`（含 `mediaType`/`size`）再 `get`。
4. Studio 侧可通过 `GET /__studio/artifact` / `/__studio/material/<res_…>` 直接读字节。
5. `render:Video id="final"` 这个 id 决定了 Output 名叫 `final.video`（见 `examples\interview\reference.svml:322–323` 与 `reference.svrun:5` 的 `<target output="final.video"/>`）。

---

## 5. 凭据与模型服务

### 5.1 Credential Store（4 种，Profile 里选一个或多个）

| 包 | 行为 | 证据 |
|---|---|---|
| `@hypit/credential-store-env` | **只读**，按名读环境变量：`credentialRef("env","IMAGE_API_KEY")`；不枚举环境 | `packages\credential-store-env\README.md:1–12` |
| `@hypit/credential-store-file` | 明文文件，项目外的 owner-private 目录；Linux 无 locker 时用 | `packages\credential-store-file\README.md:1–10` |
| `@hypit/credential-store-os` | macOS Keychain / Windows Credential Locker（Windows 走打包的 PowerShell 桥，密钥不进命令行） | `packages\credential-store-os\README.md:1–12` |
| `@hypit/credential-store-platform` | 策略包：mac/Win 用 OS locker，Linux 用文件。**`runtime init` 的默认选择** | `packages\credential-store-platform\README.md:1–10`；`packages\video-cli\src\distribution.ts:31–33` |

**对无人值守的 Web 后端，唯一合理选择是 `credential-store-env`**（其它三个要么要交互登录，要么写用户级 locker）。Profile 写法：
```json
{"credentials":{"env":{"use":"@hypit/credential-store-env"}},
 "endpoints":{"hiapi.default":{"use":"@hypit/provider-hiapi",
   "config":{"apiKey":{"store":"env","key":"HIAPI_KEY"}}}}}
```

### 5.2 Provider（模型服务）

| 包 | 服务 | 认证/协议 | 证据 |
|---|---|---|---|
| `provider-hypihub` | HypiHub（官方托管，OAuth 或 API key），覆盖图/视频/语音 + WhisperX 对齐 | `apiKey:{store,key}`，`baseUrl: https://hypit.ai`，`hypit auth login hypihub.default` | `packages\provider-hypihub\README.md:1–10` |
| `provider-hiapi` | HiAPI，`POST /v1/tasks` + 轮询，带 `Idempotency-Key` | API key | `packages\provider-hiapi\README.md:1–8` + 能力映射表 |
| `provider-pollo` | Pollo AI，`x-api-key` 头 | API key | `packages\provider-pollo\README.md:1–8` |
| `provider-monid` | Monid，`POST /v1/run` + 轮询 | API key | `packages\provider-monid\README.md:1–8` |
| `provider-tokendance` | TokenDance（Ark / MiniMax 协议） | API key | `packages\provider-tokendance\README.md:1–8` |
| `provider-media-local` | **本地 ffmpeg/ffprobe**，实现 `@hypit/media-pipeline` 的 9 个字节操作能力。**零成本** | 无凭据；`ffmpegPath`/`ffprobePath` 可配 | `packages\provider-media-local\README.md:1–12` |
| `provider-hyperframes-local` | **本地无头 Chromium 渲染** → 静音 MP4 + ffmpeg 编码；`render-visual` / `render-frames`。**零成本** | 无凭据；`chromePath`/`browserVersion`/`browserCacheDirectory`/`browserDownloadBaseUrl`/`workers`/`quality` | `packages\provider-hyperframes-local\README.md:1–20` |
| `provider-whisperx-local` | 本地 WhisperX Python 服务（`/health`、`/transcribe`） | 无凭据；`baseUrl`(默认 `http://127.0.0.1:8765`)、`expectedModel/Device/Compute/BatchSize`、`alignmentLanguages`、`modelCacheDirectory` | `packages\provider-whisperx-local\README.md:1–24` |
| `provider-image-opencv-local` | 本地 OpenCV/NumPy 图像变换合成 | 无凭据；`pythonExecutable` 可选 | `packages\provider-image-opencv-local\README.md:1–16` |

另有直接的 model 包（不是 Provider，是 SVML 里的能力声明）：`seedance`、`seedream`、`gpt-image`、`nano-banana`、`grok-imagine`、`minimax-h3`、`wan`、`pixverse`、`elevenlabs-speech`、`fishaudio-speech`、`mimo-speech`、`volcengine-matting`。

### 5.3 环境变量清单（全仓 `process.env` 扫描结果）

Hypit 自身只认这几个：
- **`HYPIT_STATE_HOME`** — 机器状态根覆盖（`runtime-host-node\src\index.ts:332`）；未设则 Windows 用 `%LOCALAPPDATA%\Hypit`，mac 用 `~/Library/Application Support/Hypit`，Linux 用 `$XDG_STATE_HOME/hypit`
- `HYPERFRAMES_BROWSER_PATH` / `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH` / `PRODUCER_HEADLESS_SHELL_PATH` — 渲染器路径覆盖（多为测试用）
- `PUPPETEER_CACHE_DIR`、`PATH`、`PATHEXT`、`NO_COLOR`、`TERM`
- `HYPIT_BROWSER_TESTS` / `HYPIT_CAPTURE_TEST_BROWSER` / `HYPIT_TEST_INSTALL_OPTION` / `HYPIT_ALPHA_PROOF_DIR` — 仅测试
- 准备下载走 mirror 用的第三方变量：`HF_ENDPOINT`、`HF_HOME`、`HF_HUB_CACHE`、`UV_DEFAULT_INDEX`、`UV_PYTHON_INSTALL_MIRROR`、`PIP_INDEX_URL`、`npm_config_registry`、`NLTK_ALLOW_PROXIED_URLOPEN`（`skills\hypit\references\environment\local-tools.md` 的 mirror 表）

**所有模型 API key 都不是固定环境变量名** —— 名字由你在 Profile 的 `credentialRef("env","<你起的名>")` 里自己定。

### 5.4 不用任何生成模型能否出片？——**能**

- `README.zh-CN.md:57`：「生成模型同样不是必需的：字幕、动效和代码渲染的画面，不调用生成模型也能编译成一条成片，因此可以不产生模型服务费用。」
- `README.zh-CN.md:171`：「**代码渲染的视频** —— 画面完全由前端代码驱动，本地渲染，无需调用生成模型 API。」
- 机制上：一条 Run 只要它的 `plan` 里所有 Need 都能由 `provider-media-local`（ffmpeg）+ `provider-hyperframes-local`（Chromium）+ `provider-image-opencv-local` 这三个本地 Provider 解析，就完全不产生外部请求。`main.ts:617` 区分了 `pricing.kind === "local"` 与否，`plan --json` 会给 `localRequestCount` / `providerRequestCount`（`main.ts:617–618`）。
- 代价：语音要你自己提供音频素材（例：`examples\interview\assets\*.wav`），没有 WhisperX 就没有词级时间轴（可以用纯 `time:Timeline` 的 authored clock 而非 semantic anchors，见 `SKILL.md:66–73`）。

---

## 6. 外部依赖（services/ 与二进制）

### 6.1 `services/` 三个都是 **uv 锁定的 Python 项目**，不是 Docker

| 目录 | npm 包名 | 是什么 | Windows |
|---|---|---|---|
| `services\whisperx` | `@hypit/whisperx-service-runtime` | **常驻的 HTTP Python 服务**：16kHz mono WAV → faster-whisper ASR → WhisperX 对齐 → 词级时间。`README.md:1–14` 明确"Runtime deployment package, not an author-importable module"。Python 3.10–3.13（lock 选 3.13），WhisperX 3.8.6 | 支持；stderr 落 `program.err.log`（`provider-whisperx-local\README.md:105`） |
| `services\yt-dlp` | `@hypit/yt-dlp-service-runtime` | 只有 `pyproject.toml` + `uv.lock`，pin 了 yt-dlp 及 EJS solver。**不是服务，是一个 venv 里的可执行文件** | 支持；`.venv\Scripts\yt-dlp.exe`（`README.md:6, 10`） |
| `services\image-opencv` | `@hypit/image-opencv-runtime` | 锁定的 OpenCV/NumPy 环境，**每个 Need 起一个有界子进程**，不是守护进程（`README.md:1–5`） | 支持 |

三者都由 **`uv`** 创建环境，装到 `HYPIT_STATE_HOME/programs/<name>/<version>/.venv`（`packages\yt-dlp\src\environment.ts:12`）。生命周期由 `hypit programs prepare|up|status|down --endpoint <instance>` 管（`local-tools.md` "Let the selected Endpoint own its Program"）。

### 6.2 宿主机必备二进制

`skills\hypit\references\environment\local-tools.md`（"Supply host executables at machine scope"）：
- **Node.js ≥ 22.15**（仓库 `.node-version` 24.14.1）
- **`ffmpeg` + `ffprobe` 必须在 PATH**（或在 Provider config 里给 `ffmpegPath`/`ffprobePath`，相对路径按 Runtime `dataRoot` 解析）
- **`uv`**（Astral）用于所有 Python 服务
- Windows 安装示例（文档原文给了 PowerShell 命令）：
  `winget install --id Gyan.FFmpeg.Shared -e` / `winget install --id astral-sh.uv -e`
- **pnpm 10.33**

### 6.3 Chromium / Puppeteer

- 根 `package.json` 的 `dependencies`：`puppeteer-core@25.10.0`、`@puppeteer/browsers@3.2.2`、`sharp@0.35.4`、`koffi@3.2.1`、`tsx@4.21.0`、`typescript@5.9.3`、`vite@8.2.2`。
- `.puppeteerrc.cjs`：`{ skipDownload: true }` —— **pnpm install 不下浏览器**，浏览器由 Provider 显式准备（`hypit programs prepare --endpoint <render-instance>` 或 `hypit capture install-browser`）。
- 渲染用的是 `provider-hyperframes-local` 选定的 Chrome for Testing；`chromePath` 可指向你自己装的 Chrome（此时**永不下载/修复**）。README 例子里一条 20s 视频用了 **64 个并发无头 Chromium 进程**（`README.zh-CN.md:95`）→ **Web 服务化时要严格限制并发，`workers`/`quality` 在 Endpoint config 里调**。
- `hypit capture` 用的是另一套（`packages/browser-capture` + `puppeteer-core`），原生页面录制需 **Chrome 153+ 且 ffprobe 在 PATH**（`capture.ts:35–43`）。

### 6.4 Windows 可跑性

- CI 矩阵 `.github\workflows\ci.yml:40` = `[ubuntu-latest, windows-latest]`，`npm-package.yml:29` 同样。→ **官方在 Windows 上跑测试**。
- `packages\build-result-fs\README.md` 专门写了 Windows 原子重命名用 `SetFileInformationByHandle(FileRenameInfoEx)` via Koffi。
- `packages\package-loader-node\src\location.ts:150–156` 专门处理 Windows 8.3 短路径。
- `bin\hypit.mjs:23` 用 `realpathSync.native` 同理。
- **唯一不可用的是根目录的 `hypit` shell 脚本**（POSIX sh）；Windows 用 `node bin/hypit.mjs` 或 npm bin shim。

---

## 7. 示例项目结构与 `.svml` 长相

### 7.1 `examples/` 七个示例

| 目录 | 类型 | 关键文件 |
|---|---|---|
| `interview` | 街头采访（reference + 3 变体） | `reference.svml/.svs/.svrun`、`swap-host.svml/.svrun`、`swap-lang*`、`ada-tracking.svs`、`spanish-tracking.svs`、`recipes.svs`、`assets/*.wav`、`hypit.runtime.json`、`package.json` |
| `podcast` | 播客切片（3 变体） | `reference.*`、`swap-app.*`、`swap-host.*`、`swap-item.*`、`kits/split-opening.svs`、`variants.md` |
| `ranking-football` | UGC 排行榜（3 变体） | `reference.svml`、`column-recipes.svs`、`reference-banana/`、`download-reused-media.mjs` |
| `complex-explainer` | 复杂解说 + 4 个项目组件包 | `packages/{launch-scenes,opening-system,single-line-captions,visual-language}` |
| `semantic-composition` | 语义合成 + 4 个组件包 | `chat.svml/.svs/.svrun` |
| `minimal-author-package` | **最小可读示例**（写组件用） | `packages/example-component/{src,preview}` |
| `provider-package` | **写 Provider 的示例** | `packages/{provider-images,provider-videos}` |

**`examples/interview/` 的结构正好就是你要的"reference → 变体"模型**：一份 `reference.svml`（324 行）+ 一份共享 `recipes.svs`（134 行）+ 每个变体一份 `swap-*.svml` 和 `swap-*.svrun`。

### 7.2 `.svml` 片段（`examples\interview\reference.svml`，1–14 行 + 30–37 行 + 311–323 行）

```xml
<?svml using="@hypit/markup@1"?>
<svml>
  <import as="media-track" from="@hypit/media-track@1"/>
  <import as="performance" from="@hypit/performance@1"/>
  <import from="@hypit/script@1"/>
  <import as="fish" from="@hypit/fishaudio-speech@1"/>
  <import as="seedance" from="@hypit/seedance@1"/>
  <import as="gpt" from="@hypit/gpt-image@1"/>
  <import as="whisperx" from="@hypit/whisperx@1"/>
  <import as="caption" from="@hypit/caption@1"/>
  <import as="film" from="@hypit/film@1"/>
  <import as="render" from="@hypit/render-hyperframes@1"/>
  <import as="recipes" source="./reference.svs"/>
  <import as="image-kit" source="@hypit/gpt-image-kits/phone-ugc-v1"/>

  <script id="story">
    <manifest-rule>
      <BOY>Hey yo! || Is this || Lamborghini || yours?
      <WIFE>OK || the || first one || is || @{manifest!} Manifest.
    </manifest-rule>
  </script>

  <film:Film id="main" canvas={vertical} timeline={speech.timeline}
    appearance={recipes.film.vertical}>
    <film:Track source={speech-picture.visual}/>
    <film:Track source={captions.track}/>
    <film:Track source={music-bed.audio}/>
  </film:Film>
  <render:Video id="final" composition={main.composition} timeline={speech.timeline}/>
</svml>
```
要点：`||` 是 Cue 断点，`@{manifest!}` 是**语义 Moment 锚点**（后面 `<emoji:Item at={story.moment.manifest}/>` 引用它），`{...}` 是值引用。`render:Video id="final"` → Output 名 `final.video`。

### 7.3 `.svrun`（`examples\interview\reference.svrun`，全文 6 行）
```xml
<?svml using="@hypit/run-markup@1"?>
<svrun version="1">
  <author source="./reference.svml"/>
  <target output="final.video"/>
</svrun>
```

### 7.4 `hypit.runtime.json`（`examples\interview\hypit.runtime.json`，全文）
```json
{"format":"hypit.runtime-local@1","dataRoot":".hypit/runtimes/local",
 "credentials":{"platform":{"use":"@hypit/credential-store-platform"}},
 "endpoints":{
   "hypihub.default":{"use":"@hypit/provider-hypihub","config":{"baseUrl":"https://hypit.ai","apiKey":{"store":"platform","key":"hypihub.oauth"},"defaultConcurrency":4,"requestTimeoutMs":120000}},
   "media.local":{"use":"@hypit/provider-media-local","config":{"defaultConcurrency":2}},
   "hyperframes.local":{"use":"@hypit/provider-hyperframes-local","config":{"workers":2,"quality":"standard","defaultConcurrency":1}}}}
```
这与 `hypit runtime init` 写出的初始 Profile 几乎一致（`packages\video-cli\src\distribution.ts:25–49`）。

---

## 8. 本地安装/构建状态：**都没有**

- `find . -maxdepth 4 -name node_modules` → **空**。仓库根、各 `packages/*`、`examples/*` 下**均无 `node_modules`**。
- `find . -maxdepth 3 -name dist -type d` → **空**。无任何 `dist/`（`dist/public/*.d.ts` 只在 `npm pack` 前由 `npm run build:public-types` 生成）。
- 无 `.hypit/`、无 `.venv/`。
- `pnpm-lock.yaml` 存在（271KB），可 `pnpm install --frozen-lockfile`。
- **结论：全新检出，未安装、未构建、未初始化 Runtime。** 任何 `hypit` 命令现在都会失败（根 `hypit` 脚本第 8 行就会报 "Hypit dependencies are not installed… run: pnpm install --frozen-lockfile"）。
- 注意 `@hypit/hypit` 是 **源码分发（source distribution）**：`package.json.files` 只打包 `packages/*/src/**`、`bin/`、`services/*/pyproject.toml` 等，**运行时靠 `tsx` 直接执行 TS**，所以"pnpm install 完就能跑"，没有独立的 build 步骤（`npm run check` 只是 `tsc --noEmit`）。

---

## 9. 结论：Web 封装层驱动 Hypit 的 3 种现实方案

前提共识：**"看懂参考视频并写出 SVML" 这一步需要一个多模态 LLM Agent**。Hypit 只是它的工具箱。所以方案差异主要在"这一步谁来跑"和"其余确定性步骤怎么调"。

---

### 方案 A：后端 spawn `hypit` CLI 子进程（**推荐作为骨架**）

**做法**：每个用户任务 = 一个独立工作目录（含最小 `package.json` + `hypit.runtime.json`）。后端用 `child_process.spawn('node', [<dist>/bin/hypit.mjs, ...args])`，统一加 `--json`；stdout 解析最终 `format` 化 JSON，stderr 逐行推给前端做进度。

**能覆盖**：`media prepare-fetch/fetch`（用户粘贴链接）、`media probe/frames/tile/tiles`、`transcribe`、`check`、`plan`、`pricing`、`build --follow`、`inspect`、`get`、`activity --watch --jsonl`、`snapshot`、`runtime/programs/auth/doctor`。

| 优 | 劣 |
|---|---|
| 与官方文档/Skill 的命令**完全一致**，升级 Hypit 不用改胶水代码 | 每次调用都要 `tsx` 冷启动 + 包解析，**启动开销可观**（TS 源码即时编译） |
| 进程隔离，一个任务崩了不拖垮 web 服务 | 进度只能从 **stderr 文本**解析（`buildProgressLines` 的人类文本），没有结构化进度流 |
| 退出码语义简单（0/1） | 退出码太粗（无法区分"配置缺失"和"生成失败"），必须解析 `hypit.cli-error@1` 的 `error.code` |
| `--json` 的 `format` 字段稳定、带版本号，好做兼容 | Build 进度要额外起 `hypit activity --watch --jsonl` 才有结构化流 |
| Windows/Linux 一致（用 `node bin/hypit.mjs`，别用根 `hypit` sh 脚本） | 并发多任务时 Worker/浏览器进程资源争抢需自己限流 |

**要点**：
- 工作目录用 `--workspace <dir>` 显式钉死，别依赖 cwd 的 `package.json` 查找（`project-files.md:41–56`）。
- 凭据用 `@hypit/credential-store-env` + 给子进程注入 env（**唯一适合无人值守的 Store**）。
- Result 仓库可通过 `hypit.results.json` 指到 S3（`@hypit/build-result-s3`），避免本地磁盘膨胀。

---

### 方案 B：后端在同一 Node 进程内 import 程序化 API（**性能最好，耦合最深**）

**做法**：照抄 `bin\hypit.mjs:23–32` 的 bootstrap（`tsx` register + `installDistributionPackageResolution`），然后 `import { runVideoCli } from "@hypit/video-cli"`，传一个自定义 `CliIo`（`packages\cli\src\output.ts:14–25`）把 `write`/`writeProgress` 直接接到 SSE/WebSocket。

| 优 | 劣 |
|---|---|
| **没有进程启动开销**，模块与编译缓存跨任务复用 | 依赖的是 **`private: true` 且不在根 `exports` 里的内部包**（`@hypit/cli`、`@hypit/video-cli`、`@hypit/runtime-local`…），**无 semver 保证，升级可能随时炸** |
| **拿得到结构化进度**：`observeBuild` 的 `onProgress(BuildProgressView)`（`observation.ts:13–20`）比文本行好用得多 | 需要 `tsx` 常驻在生产 Node 进程里（`register()` 全局改 ESM loader），会影响你自己的代码加载 |
| 可以只调需要的层：`createVideoCompiler` 做纯 `check`、`readRuntimeConfigPricing` 做纯估价，不起 Worker | 一次 `runVideoCli` 抛异常可能污染进程状态（Runtime Host 是有缓存的 Map，`main.ts:92–108`） |
| 可以自己实现 `readSecret`，接管 auth 流程 | 想完全绕开 `runVideoCli` 自己拼 `runtime.build(request)`，要复刻 `main.ts:346–426` 约 200 行 + 6 个内部包类型 |

**折中建议**：**Web 服务进程内只用 A 方案 spawn；如果要结构化进度，把"worker 进程"自己写成一个薄 Node 脚本（内部用 B 方案的 `CliIo`），再由 web 服务 spawn 这个脚本并通过 stdout 的自定义 JSON-lines 协议通信**。这样既拿到结构化进度，又保留进程隔离。

---

### 方案 C：后端用 Claude Agent SDK 无头驱动 `/hypit` skill（**唯一能真正"复刻"的方案**）

**做法**：后端为每个任务开一个 headless Claude Code / Codex 会话，工作目录 = 任务目录，装好 `skills/hypit`（`npx skills add hypit-ai/hypit` 或直接把 `skills/hypit/` 复制进 `.claude/skills/`），prompt = `"/hypit 复刻这个视频：./references/src/source.mp4，把 X 换成 Y"`。Agent 自己跑 `media fetch/transcribe/tiles` → 写 `ANALYSIS.md`/`TIMELINE.md` → 写 `.svml`/`.svs`/`.svrun` → `plan`/`build`/`get`。

| 优 | 劣 |
|---|---|
| **这是官方设计的唯一"复刻"路径**（`SKILL.md` 全篇、`docs/zh/quickstart.md:29–37`）；从 mp4 到 svml 没有别的实现 | 不确定性高：同一输入两次产出不同 SVML；失败模式发散，**难以给用户稳定的进度条** |
| 直接获得整套 Skill 的领域知识（图像/视频/配音/字幕/MG 的 craft 页共 40+ 篇） | 需要给每个任务一份 Agent 额度，**成本 = 模型 token + 生成模型费用**，且 Agent 会自主调用付费 Provider（`SKILL.md:213–218` 要求"先与用户确认预算"——无人值守时要自己加闸） |
| 能处理"用户模糊需求"（"把主播换成香蕉猫"） | Agent 有文件系统写权限与 shell 权限，**多租户沙箱必须自己做**（容器/独立用户/只读挂载） |
| Agent 会主动写 PROGRESS.md，可作为断点续跑的状态 | 耗时长（README 例子：一条 20s 视频含生成 + 64 进程渲染，成本 ~$1.1） |

**降险做法**：
1. **两段式**：第一次任务让 Agent 产出 `reference.svml` + `recipes.svs`（"模板"），**人工/自动审一次**，之后的"改变体"不再用 Agent —— 变体只是改 `<script>` 里的台词、`text:Value` 里的 prompt、`swap-*.svml` 的几个 id 引用，**可以用纯程序化的 XML 编辑 + `hypit build` 完成**（见 `examples/interview/swap-host.svml` vs `reference.svml` 的差异模式）。这正是 README 说的"一份 workflow，100 个变体"。
2. 用 `hypit plan --json` 在 Agent 之后、`build` 之前做**成本闸门**（`localRequestCount` / `providerRequestCount` / `pricing` 都有），把"花钱"这一步从 Agent 手里收回到你的后端。

---

### 推荐组合（最现实）

```
Web 前端
   │ 上传 mp4 / 粘贴链接
   ▼
后端 Job 队列（每 job 一个目录 + 容器）
   ├─ 阶段1 证据准备   ── 方案 A：spawn `hypit media fetch/probe/transcribe/tiles --json`
   ├─ 阶段2 复刻成 SVML ── 方案 C：headless Claude Agent SDK + /hypit skill（**只做这一步**）
   ├─ 阶段3 审计闸门   ── 方案 A：`hypit check --json` + `hypit plan --json`（成本/可行性把关，可插人工审批）
   ├─ 阶段4 变体生成   ── 纯程序：复制 svml + 改 <script>/<text:Value> + 写新 .svrun（不用 Agent）
   ├─ 阶段5 构建成片   ── 方案 A：`hypit build <run> --follow --json` + `hypit activity --watch --jsonl` 做进度
   ├─ 阶段6 预览       ── `hypit studio --run <svrun> --port <动态>` 反代其 GET 路由；或 `hypit snapshot --studio <url>` 抽帧做轻预览
   └─ 阶段7 下载       ── `hypit get <build-id> --output final.video --to <path> --json`
```

**部署侧必须先解决的 5 件事**：
1. `pnpm install --frozen-lockfile`（当前未装）；Node ≥ 22.15。
2. 宿主机装 `ffmpeg`/`ffprobe`/`uv`，跑一次 `hypit programs prepare` 把 Chromium 和 Python 环境预热（否则首个任务会卡在几百 MB 下载上）。
3. Profile 改用 `@hypit/credential-store-env`，API key 走容器 env。
4. 限并发：`hyperframes.local` 的 `workers` + 各 Endpoint 的 `defaultConcurrency`（默认渲染会开几十个 Chromium）。
5. Studio 的写操作有 localhost + same-origin 硬校验（`mutation-origin.ts:3–20`），**只反代 GET**；要做"网页里编辑"得自己基于 `/__studio/document` 重写一层 UI，或走 Agent 改源文件。

