# Development Plan — Clone Studio

> 本文件记录项目的开发阶段划分、当前进度和剩余工作。
> 新 session 启动时应首先阅读此文件，了解项目状态后再继续开发。
>
> **当前进度（2026-09-22）**：Phase 0 ✅· Phase 1 ✅ · Phase 2 ✅（带两项遗留）· Phase 3 ✅ · **Phase 4 ✅**（五个 Task 交付，4.3 过六轮、4.4 / 4.5 各过四轮 review→fix；AC-004 / AC-005 / AC-006 真机浏览器实跑通过，用户实测确认）· **Phase 5 ✅**（五个 Task，review→fix 共 5.1 五轮 / 5.2 七轮 / 5.3 七轮 / 5.4 四轮 / 5.5 两轮；AC-007～010 真机通过，AC-002 自动化通过、真机转 Phase 13）· 下一步 Phase 6（「本机渲染不通」09-23 复测已不复现，改为偶发风险）。
> 分支 `feat/clone-studio`。「本机渲染不通」2026-09-23 复测两种失败都不再复现（900 帧与 4112 帧本地渲染均成功、ffprobe 核对通过），
> 不再阻塞 Phase 6，改记为偶发风险，见「已知风险」。
>
> 依据：Product-Spec.md v1.5、Design-Brief.md v1.0、设计稿 https://claude.ai/artifact/7DWGBWDbka6Wm71vV6TBbH（7 屏，UI 以设计稿为准）、Hypit-Research.md、用户提供的《Codex 生图配置说明》（不随仓库分发，要点已写入 Spec REQ-011）。
> 代码目录：`clone-studio/`（pnpm workspace：`server/`、`web/`、`providers/`）。`hypit-main/` 只读，不得修改。

## 总体架构

- `server/`：Fastify 后端，只绑 127.0.0.1。三类长任务都由它独占调度：确定性 hypit CLI 子进程、Claude Agent SDK 会话、出片 build。状态机只在后端写，前端只读 + 发动作。实时数据走 SSE。
- `web/`：React SPA，开发期 Vite 代理到后端，生产期由后端静态托管。
- `providers/codex-image/`：项目自有的 Hypit Provider 包，经 `--package-root` 挂给 hypit。
- 数据根目录（默认 `%LOCALAPPDATA%\CloneStudio`）：`app.db`、`secrets.json`、`clients/<id>/templates/<id>/`（每个模板一个 Hypit 工程目录，变体在其 `productions/<id>/`）。

功能依赖：骨架与库 → hypit 调用层与体检 → 归档 → 导入 → Agent 运行器 → 复刻与估价闸门 → 出片与验货 → 变体与素材审核 → 成片库与台账 → 模型档案 → Codex 生图 → 生视频通道 → 可靠性收尾。Agent 运行器与花钱闸门是最大风险，排在前半段。

---

## Phase 0: 内核就绪与三项先行验证（不写产品代码）

**交付内容**：
- 在 `hypit-main/` 执行 `pnpm install --frozen-lockfile`；安装 ffmpeg（`winget install --id Gyan.FFmpeg.Shared -e`）与 uv（`winget install --id astral-sh.uv -e`）；用 `node bin/hypit.mjs --version` 确认可跑。本机 pnpm 为 11.6，若与仓库声明的 pnpm@10.33 冲突，用 `corepack` 切到 10.33。
- 验证一：在 `hypit-main/examples/minimal-author-package` 或一个无生成模型的最小 Run 上跑通 `check → plan --json → build --follow --json → get`，记录各命令真实 JSON 形状，解 Spec 的 Q-003（pricing 估价与实际花费能否拿到）。
- 验证二：写一个 30 行脚本用 `@anthropic-ai/claude-agent-sdk` 在订阅登录下跑一次最小会话，确认 `total_cost_usd` 是否有值、`canUseTool` 能否拒绝一条 Bash 命令、`resume` 可用，解 ASM-002。
- 验证三：按《Codex生图配置说明》第 3 节手动出一张图，确认登录与 `windows.sandbox="elevated"` 在本机可用。
- 把三项结论写进 `clone-studio/docs/spike-notes.md`，与假设不符的回写 Product-Spec。

**关键文件**：
- `clone-studio/docs/spike-notes.md` — 三项验证的命令、真实输出样例、结论
- `clone-studio/scripts/spike-agent.mjs` — Agent SDK 最小会话脚本
- `clone-studio/scripts/spike-hypit.ps1` — hypit 全链路命令序列

**验收标准**：
- `node hypit-main/bin/hypit.mjs doctor --json` 有输出 ✅
- spike-notes.md 对 Q-003、ASM-002、Codex 出图三项各有"成立 / 不成立 + 证据" ✅
- 可播放 mp4 ✅（2026-09-23 补齐）：Phase 0 当时只做到 `get` 导出已有 Build Output（10.03s、h264 720×1280、30/1）；本机新渲染当时失败，09-23 复测 900 帧与 4112 帧本地渲染均成功，导出 mp4 经 ffprobe 核对（h264 1080×1920、30/1、帧数与文档一致），见「已知风险」与 spike-notes「2026-09-23 复测」

---

## Phase 1: 工程骨架、数据库、设计 token 与应用外壳

**交付内容**：
- 搭建 pnpm workspace，`pnpm dev` 同时起后端（127.0.0.1:4310）与前端（5173，代理 `/api`）
- 创建 SQLite 全部表与迁移机制；启动时把遗留"运行中"任务标为"中断"
- 实现设计稿的应用外壳：240px 侧栏、主区、可收起的右侧抽屉容器、深色 token（Design-Brief §5）、Geist + JetBrains Mono
- 实现基础组件：按钮四变体、输入框、下拉、徽标、状态标记 CMP-003、危险确认弹窗 CMP-012、toast
- <1280px 视口显示"请在桌面浏览器使用"

**关键文件**：
- `clone-studio/pnpm-workspace.yaml`、`clone-studio/package.json` — workspace 与脚本
- `clone-studio/server/src/index.ts` — Fastify 启动，只绑 127.0.0.1
- `clone-studio/server/src/config.ts` — 数据根目录、hypit-main 路径解析
- `clone-studio/server/src/db/schema.sql`、`server/src/db/index.ts`、`server/src/db/migrate.ts` — 建表与迁移
- `clone-studio/server/src/lib/sse.ts` — SSE 通道（按主题订阅、断线重连补发）
- `clone-studio/web/src/styles/tokens.css` — 颜色、字号、间距、圆角变量
- `clone-studio/web/src/app/Shell.tsx`、`web/src/app/Sidebar.tsx`、`web/src/app/routes.tsx` — 外壳与路由
- `clone-studio/web/src/components/ui/*.tsx` — 基础组件
- `clone-studio/web/src/lib/api.ts`、`web/src/lib/useSse.ts` — 请求与 SSE 封装

**验收标准**：
- `pnpm dev` 启动后浏览器看到与设计稿一致的空外壳；`pnpm build`、`pnpm typecheck` 通过
- `app.db` 含全部表；后端只在 127.0.0.1 监听

---

## Phase 2: hypit 调用层、环境体检与设置页（REQ-008，FLOW-001）

**交付内容**：
- 实现 hypit 子进程封装：`node <hypit-main>/bin/hypit.mjs … --json --workspace <dir>`，解析 `format` 化 JSON 与 `hypit.cli-error@1`，stderr 逐行回调，子进程登记表随后端退出清理，每次调用落 `hypit_calls` 表
- 实现密钥存储：`secrets.json` 仅当前用户可读，接口只回打码值
- 实现模板工程目录生成器：最小 `package.json` + `hypit.runtime.json`（`credential-store-env`；按已验证的服务写 TokenDance / HypiHub / 本地 media、hyperframes、whisperx endpoints 与 workers）
- 实现体检（现 9 项）：Node、hypit 依赖、ffmpeg/ffprobe、uv、WhisperX 本地转写（Phase 4 Task 4.5 加）、Chrome Headless Shell、Claude Code 登录、TokenDance key、Codex CLI；每项给"是什么、现状、怎么修"，修复命令可复制
- 命令探测必须先用 `where` / `which` 解析成真实路径再 spawn。Windows 上 npm 全局命令是 `.cmd` 垫片，`shell: false` 直接 spawn 命令名会得到"不在 PATH"的假阴性；`.cmd` 垫片自 Node 20 起（CVE-2024-27980）必须经 `cmd.exe` 启动，因此这条路只允许跑写死的参数，不得喂用户输入
- Chrome Headless Shell 装在 `~/.cache/hyperframes/chrome`，不在 `hypit-main/` 内
- 实现设置页（设计稿"设置"画板）：体检、TokenDance key 验证、HypiHub 浏览器授权连接、限额与熔断、并发、路径；改完即存
- TokenDance key 验证不能用 `hypit doctor --endpoint tokendance.default`（实测对故意写错的 key 也返回 `ok: true`；doctor 只校验 Profile 形态，`auth status` 也只报凭据在不在，hypit 没有校验远端凭据的命令）。改为向生成接口发一个**结构合法但模型名故意不存在**的请求：网关顺序是体解析 → 鉴权 → 模型校验，坏 key 得 401 原文，好 key 卡在模型校验、不建任务不花钱。模型目录接口 `/gateway/v1/models` 是公开的，不带 key 也回 200，验不了
- 体检里的 TokenDance 一项看"验证过没有"而不是"配置了没有"：AC-023 要求 key 错时出片按钮保持禁用，只看配置与否挡不住。`settings` 增 `tokendance_verified_at` / `hypihub_verified_at` 列，key 一改即清空
- 任一 P0 体检未过时主区顶部出现琥珀横幅

**关键文件**：
- `clone-studio/server/src/hypit/cli.ts` — spawn 封装与错误模型
- `clone-studio/server/src/hypit/workspace.ts` — 工程目录与 runtime profile 生成
- `clone-studio/server/src/lib/procs.ts` — 子进程登记与清理
- `clone-studio/server/src/lib/secrets.ts` — 密钥读写与打码
- `clone-studio/server/src/health/checks.ts`、`server/src/routes/health.ts`、`server/src/routes/settings.ts`
- `clone-studio/web/src/pages/SettingsPage.tsx`、`web/src/components/HealthRow.tsx`（CMP-011）、`web/src/components/HealthBanner.tsx`

**验收标准**：
- AC-022、AC-023 通过
- 把 ffmpeg 移出 PATH 后重新检测，对应行变红且出现横幅；恢复后变绿
- 生成的工程目录能被 `hypit doctor --workspace <dir> --json` 识别。注意：不带 `--runtime` 时 `profileSource` 为 `none`（hypit 不会自动选中目录里的 profile），要验 profile 本身立不立得住须显式带 `--runtime <dir>/hypit.runtime.json`

**本阶段遗留（未实现，不影响 Phase 3-5，须在用到前补上）**：
- 「一键准备」按钮（调 `hypit programs prepare` 并推进度）未实现。当前 Chrome Headless Shell 一项只给提示命令，靠首次出片时 hypit 自己下载。补在 **Phase 6 开工前**，那时才真的需要它就绪
- ~~WhisperX 服务连通性检测未实现~~ **Phase 4 Task 4.5 已补**：体检问服务的 `/health`，并在转写前自动拉起（见 Phase 4 进度表）
- HypiHub 浏览器授权连接未实现，补在 **Phase 6**

---

## Phase 3: 客户 / 模板归档（REQ-001，FLOW-004）

**交付内容**：
- 实现客户与模板的创建、重命名、删除接口；删除级联库记录与磁盘目录，删除前中止关联任务
- 实现侧栏树（状态点、悬停"…"菜单、+ 新客户）、首页空状态、客户页模板紧凑列表
- 实现模板页框架：页头（模板名就地改、累计花费）+ 五步步骤条 CMP-001（锁定 / 可进入 / 当前 / 进行中 / 需处理 / 完成 / 失败）+ 步骤工作区路由；刷新保持当前模板与步骤

**关键文件**：
- `clone-studio/server/src/routes/clients.ts`、`server/src/routes/templates.ts`
- `clone-studio/server/src/services/deletion.ts` — 停任务 → 删目录 → 删库，失败整体回滚
- `clone-studio/web/src/pages/HomePage.tsx`、`web/src/pages/ClientPage.tsx`、`web/src/pages/TemplateLayout.tsx`（实际落在 `pages/` 下，没有 `template/` 层）
- `clone-studio/web/src/components/Stepper.tsx`（CMP-001）、`web/src/components/TaskRow.tsx`（CMP-002）

**验收标准**：
- AC-001、AC-003 通过；AC-002 在 Phase 5 任务可运行后补验
- 同名、超长名在输入框下红字提示

**进度与交接（2026-09-20，因重启中断）**

Task 拆分，按序做，每个走 review→fix 循环：

| Task | 内容 | 状态 |
|---|---|---|
| 3.1 | 后端：客户/模板 CRUD + 级联删除服务 | ✅ de5aba6。审查 Stage 1 过、Stage 2 的 5 条应修已修完（b7ec073） |
| 3.2 | 前端：侧栏树接真实数据 + 行尾「…」菜单（重命名/删除）+ 新建客户 | ✅ 77cebe9 + 6682239（二轮审查修复）。已真机验证 |
| 3.3 | 前端：首页空状态 + 客户页模板紧凑行列表 | ✅ 96f9aa6 + 824ac72 |
| 3.4 | 前端：模板页框架（页头 + 步骤条 CMP-001 + 步骤路由 + 刷新保持） | ✅ d1766a6 + c05595d。`TemplatePlaceholderPage` 已删 |

**Task 3.1 审查后的改动（b7ec073）**，Task 3.3 往后要按新形状对接：
- `deleteClient` / `deleteTemplate` 改成 `async`，路由要 `await`
- 删除失败时任务状态写 `interrupted`（不是 `cancelled`），因为对象保留、用户还能重跑
- 新增 `purgeTrash()`，`index.ts` 启动时调一次
- `DIRECTORY_BUSY` 的 message 里可能追加「工作目录未能挪回原处，现暂存在 …」，前端原样展示即可

**二轮审查（重派）结论**：Stage 1 抓到一条阻塞 —— 点模板行会打到没匹配的路由，且路由表没有 `errorElement`，整个 `<Shell/>` 被 react-router 的内置错误页顶掉。这条从 Phase 1 就埋着，但那时侧栏是空数组、模板行渲染不出来，Task 3.2 接上真实数据才让它首次可点。已在 6682239 修掉：根路由加 `errorElement` + 通配兜底页 + `clients/:clientId/templates/:templateId` 占位路由。Stage 2 的 12 条（Q1-Q12）已全部处理，含 `killAll` 留孤儿孙进程、状态点只靠颜色区分、`purgeTrash` 能拦住后端启动、fetch 无超时。两个超 300 行的文件已拆：`deletion.ts` → 出 `trash.ts`，`Sidebar.tsx` → 出 `ClientNode.tsx` + `useArchiveActions.ts`（后者 Task 3.3 的首页「新建客户」直接复用）。

**真机验证已补做**（浏览器扩展 1440×900）：点模板行进占位页且侧栏保留、不存在的模板 id 显示「这个模板已经不存在了」、完全不匹配的地址进兜底页。真机还抓到一个 typecheck 与 build 都看不见的问题：**`max-w-lg` 在这套 Tailwind 配置里解析成 16px**（没有 `--container-*` 刻度），兜底页文字被挤成一字一行。结论：**不要用 `max-w-*` / `w-<数字>` 之外的语义刻度**，跟项目既有先例走显式值（弹窗 `w-[420px]`、toast `w-80`、HealthRow `max-w-[380px]`）。

**设计稿偏差备案**：模板行右 padding 用 `pr-8`（32px）而非设计稿的 12px，那 20px 是给行尾「…」菜单让位。代价是模板名的 `truncate` 提前 20px 截断。

**Task 3.3 落地要点**（3.4 会复用）：
- `components/TaskRow.tsx` 是 CMP-002 的原语，列宽由调用方给。SCREEN-006 的变体队列是同一种行，直接复用，别再手搓一份
- `components/ui/TemplateDot.tsx` 是状态点的单一来源，侧栏与客户页共用
- `lib/format.ts` 管花费与「最近活动」的格式
- `useArchiveActions` 现在含 createClient / createTemplate / rename / remove / askDelete，模板页要用改名直接接这个
- 可点的行必须给 `openLabel` 显式无障碍名，否则名字由行内容拼出来，跟行尾菜单按钮撞车
- ~~`HomePage.tsx` 恒显示「还没有客户」~~ 已改：按客户数分两句话

**Phase 3 收口时记下的三件事，Phase 4 起会用到：**

1. ~~两条产品规则是在代码层发明的，待拍板~~ **已回写 Spec（v1.7）**，真相源回到 Product-Spec：
   - **⑤成片 与 ④变体 同一道闸门，验货「通过」才解锁**（SCOPE-004 备注、REQ-004 规则、AC-040）。原实现的 `outputs > 0 就解锁 ⑤` 与 FLOW-002 完成状态「复刻片在已验货那一刻才入库成片」直接冲突，已按 Spec 改回，`StepInput` 不再需要 `outputs`。
   - **进模板页的默认步骤与地址行为**写进 REQ-001 规则段：默认落需处理 ＞ 进行中 ＞ 失败 ＞ 能进的最后一步；步骤写进地址、刷新停在原处；地址指定未解锁或不存在的步骤时送回算出来的那一步。
2. **`steps.ts` 里两条推导从未在真实数据上跑过**：Phase 3 全仓没有任何一处写 `templates.source_path`，也没有任何一处 `UPDATE templates SET status`（唯一的 `UPDATE templates` 是改名）。所以 `hasSource` 恒 false、`status` 恒 `importing`，`failed` 落点判定与 `cloning`/`approved` 等分支只有单元测试证明。**Phase 4 接上写入方之后必须补真机验证。**
3. **`disabled` + `title` 给不出「原因 tooltip」**（Design-Brief 组件通用七态要求禁用态给原因）：浏览器对 disabled 表单控件不派发指针事件，原生 title 气泡不出现。这是 Phase 1 的 `components/ui/Button.tsx` 就定下的先例（还额外加了 `disabled:pointer-events-none`），`Stepper` 照着走。**要修得整体修**——换 `aria-disabled` + onClick 拦截，或包一层 wrapper 承载 tooltip，别只改一处。

**写 UI 时的两条硬约定**（都是真机实测踩出来的）：
- 不要用 `max-w-*` 这类语义刻度，这套 Tailwind 配置里没有 `--container-*`，`max-w-lg` 会解析成 16px。跟项目先例走显式值（弹窗 `w-[420px]`、toast `w-80`、HealthRow `max-w-[380px]`）。
- 自定义 CSS 一律写进 `@layer`。无层规则永远压过 Tailwind 的全部工具类——侧栏链接颜色那次事故就是这么来的，全应用所有 `<a>` 的 `text-*` 类集体失效。

**截图工具的坑**（Task 3.4 验证时会再遇到）：浏览器扩展的抓图帧固定约 1425px 宽，而本机页面 CSS 视口约 2327px，**右侧内容拍不进画面，`resize_window` 调了也没用**。别据此断言「东西不见了」——要验右侧布局用 `javascript_tool` 量 `getBoundingClientRect`。

**前端测试栈已定：jsdom + @testing-library**（1924c5a，用户拍板）。选型表里 vitest 那行原先只写了服务端用途，现在前端同一套。Playwright 留到 Phase 5 之后再议——那时才有值得端到端钉住的主流程，现在上只能测「点一下新建客户」，撑不起维护成本。

落地细节，Task 3.4 往后写用例直接照这个来：
- 版本：jsdom 30.1.0 + @testing-library/react 16.3.3（peer 明确支持 React 19）+ user-event 14.6.7 + jest-dom 7.0.1
- `web/vitest.config.ts` 单独一份，不混进 vite.config；`src/lib/**` 仍跑 node 环境
- `src/test/setup.ts`：**jsdom 30 实测缺 `showModal` / `EventSource` / `matchMedia` / `scrollIntoView`**，逐个补桩。补桩覆盖到的行为不算被测过——弹窗的真模态性、焦点陷阱、SSE 的断线重连都要靠真机看
- `src/test/harness.tsx`：只桩 fetch 那一层，组件、react-query、路由全是真的。`renderApp()` 用真实路由表跑整个外壳，不另抄配置。桩不中的请求直接抛，免得静默返回 undefined 变成假绿
- **用例写完要做变异验证**：把被测代码改回错误实现，确认对应用例真变红。跑绿不等于测到了

Task 3.1 已落地的接口，前端直接照这个对接：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/clients` | 侧栏树 `{clients:[{id,name,createdAt,templates:[{id,name,status}]}]}` |
| POST | `/api/clients` | 建客户 `{name}` → 201 |
| GET | `/api/clients/:id` | 客户页：`{client, templates:[{...,stats:{outputs,totalCostUsd,costIsEstimate,lastActivityAt}}]}` |
| PATCH | `/api/clients/:id` | 改名 `{name}` |
| GET | `/api/clients/:id/deletion-impact` | 弹窗用：`{templates,productions,runningTasks,directories}` |
| DELETE | `/api/clients/:id` | 级联删除，返回 impact |
| POST | `/api/clients/:id/templates` | 建模板 `{name}` → 201 |
| GET/PATCH/DELETE | `/api/templates/:id`、`/api/templates/:id/deletion-impact` | 同上，模板维度 |

- 错误形状统一 `{error:{code,message}}`。重名 `409 NAME_TAKEN`，文案就是「名称已存在」，直接贴输入框下（AC-003）；超长 `400 NAME_TOO_LONG`；不存在 `404`；目录被占 `409 DIRECTORY_BUSY`。
- 增删改后后端发 SSE：topic `global`、event `archive`。**前端 `web/src/lib/useSse.ts` 的事件名清单里还没有 `archive`，Task 3.2 要补进去**，否则侧栏不会自动刷新。
- `Shell.tsx` 里 `const clients: SidebarClient[] = []` 是 Phase 1 留的占位，Task 3.2 换成真实 query。
- `HomePage.tsx` 的「新建客户」按钮现在是 `disabled` + `disabledReason="新建客户在 Phase 3 接通"`，Task 3.3 要接通。

~~**Task 3.2 开工前要先定的一件事**：三级文字色偏差~~ **已改**（29a465b）：`--color-text-tertiary` 从 `#666c75` 改为 `#8a909a`，全局 17 处引用都走这一个 token，无硬编码色值。

设计稿实测值（Task 3.2-3.4 直接用，取自 `project/Reference.dc.html`）：
- 侧栏客户行：高 32、`padding 0 12`、折叠箭头 10px `#8A909A`、客户名 13/500
- 侧栏模板行：高 32、`padding 0 12px 0 30px`、`radius 6`、`margin 0 6`；选中 `bg #1D2024` 且状态点带 `box-shadow 0 0 0 3px #19E3B133`；名称选中 `#ECEEF1`、未选 `#9BA1AA`
  （~~现有 `Sidebar.tsx` 用的是 `pl-[26px]`~~ 已在 77cebe9 对齐为 `pl-[30px]`，选中态光环用新增的 `.dot-ring` 工具类）
- 模板页头：高 56、`padding 0 24`；面包屑「客户名 13px `#9BA1AA` / 分隔 `#8A909A` / 模板名 18/600」；右侧「模板累计」12px + 金额 mono 13px
- 步骤条：高 44、`padding 0 24`、步间距 12；每步 `padding 0 4`、底边 2px（当前 `#19E3B1`，其余 transparent）；序号圆 18px、1px 描边、mono 11px，当前显数字且主色，未解锁显 `·` 且 `#8A909A`；步名 13px，当前 600 `#ECEEF1`，其余 400 `#8A909A`；步与步之间一根 28×1px `#2A2E33` 连接线
- 主工作区：`padding 20px 24px`、`gap 20`

设计稿只画了 7 屏（①参考 ②复刻 ③验货 ④变体队列 ④素材审核 ⑤成片 设置），**首页空状态与客户页没有画**，Task 3.3 按 Design-Brief SCREEN-002 + CMP-002 实现，不自由发挥。

---

## Phase 4: 参考视频导入与证据准备（REQ-002，设计稿"① 参考"）

**开工前的实测事实（2026-09-20，素材取自 `clone video/test1`）**

命令接口与 Spec 一致，`media` 没列在顶层 `--help` 里但确实存在（`probe`/`cut`/`frames`/`tile`/`tiles`/`boundaries`/`fetch`/`prepare-fetch`）。三步实跑结果：

| 步骤 | 命令 | 实测 |
|---|---|---|
| probe | `media probe <file> --json` | 扁平对象 `{path,duration,hasVideo,width,height,frameRate,hasAudio}`，**成功时不带 `ok` 信封** |
| transcribe | `transcribe <file> --to <json> --language <code> --workspace <ws>` | 19.5s 视频耗 14.2s；输出 `hypit.transcript@1`，`passages[].words[]` 带 `start_seconds`/`end_seconds`/`score` |
| tiles | `media tiles <file> --frames <n> [--transcript <json>] --to <dir> --json` | 耗 8.3s，产出 2 张拼图；返回 `{directory,columns,rows,cellWidth,grids[]}`，默认 3 列 3 行、cell 480 |

**两个必须先解的坑**：

1. ~~工作目录没「选中」Runtime Profile~~ **Task 4.1 已解**。hypit 明说「Selection is read only from that project's `.hypit/runtime`」，且不做文件名发现、不继承父目录；Phase 2 的 `createWorkspace` 只写了 `hypit.runtime.json`，于是 `transcribe` 报 `No Runtime Profile is selected`。
   **实现取的是直接写文件，不 spawn `runtime use`**：实测 `runtime use` 也只写 `.hypit/runtime` = `hypit.runtime.json`、`.hypit/.gitignore` = `*` 两个文件，与我们的产出**逐字节相同**（审查用 `diff -r` 验过）；而每次 spawn 约 1.93 秒，建模板在同步路径上、单测里有 22 处调用，spawn 会给套件加四十多秒并让单测依赖 hypit 二进制。
   代价是 hypit 改格式时这里会失效，**由 `server/src/hypit/workspace.contract.test.ts` 钉住**：整套只 spawn 一次 `doctor`（约 2 秒），断言 `profileSource === "project"` 且 `selectionFile` 指向我们写的文件；hypit CLI 不在时整组跳过。
   顺带记一个坑：`runtime use` 的 profile 参数必须给绝对路径（按 cwd 解析，给相对路径会 ENOENT），但它落进 `.hypit/runtime` 的仍然只是裸文件名。
   存量迁移在 `server/src/services/workspace-migration.ts`，启动时跑，**同时补 `.hypit/runtime` 与 `references/src`**——只补前者的话，Phase 4 往 `references/src/source.mp4` 落盘时只有存量模板会 ENOENT，用新模板自测百分百测不出来。
2. **WhisperX 的 `punkt_tab` 在本机下不下来。** `raw.githubusercontent.com` 被 DNS 污染，解析结果里除 4 个正常 IPv4 外多一个 `::`，hypit 的安全层挑中它判为 `SSRF attempt to restricted IP ::`。**已离线修复**：把 punkt_tab 解压进 `%LOCALAPPDATA%\Hypit\programs\whisperx-<endpoint>
ltk_data	okenizers\`（路径来自 `provider-whisperx-local/src/program.ts` 的 `join(stateRoot,"nltk_data")`，**不是** `resources.py` 默认的用户缓存）。`resources.py` 里 `prepare_punkt_tab` 会先 `assert_punkt_tab` 命中就直接 return，不碰网络。修复后 `programs up --endpoint whisperx.local` 返回 `ready: true`。这条要写进 Task 4.5 的体检修复指引。


**进度与交接（2026-09-22）**

| Task | 内容 | 状态 |
|---|---|---|
| 4.1 | 工作目录选中 Runtime Profile + references/src，含存量迁移 | ✅ 9080bff |
| 4.2 | 证据流水线：取源 → probe → transcribe → tiles，单步重试、超时、SSE 推送 | ✅ 94af40e + 98ac492（审查 16 条修复） |
| 4.3 | 上传（流式落盘）+ 带 Range 的播放接口 | ✅ 3fa71bd + 六轮 review→fix（见下） |
| 4.4 | 前端 ① 参考页：导入表单 + 播放器 + 证据清单，SSE 驱动刷新；步骤条按证据状态判断失败落在哪一步；设置页按设计稿改卡片；重试与后端重启时模板状态同步 | ✅ 四轮审查 |
| 4.5 | WhisperX 就绪：转写前探 `/health`、没在跑就 `programs up` 自动拉起（核对 ok/ready，起不来原样报因）；体检加「WhisperX 本地转写」，端口被占 / 缺 punkt_tab 拦截并给修复命令。Spec 回写 v1.8 | ✅ 四轮审查 |

**Task 4.3 审查定下的上传约定**，改 `routes/media.ts` 前必读：
- **不许给 `@fastify/multipart` 加 fields / files / parts 上限。** 插件触发任一上限都会 unpipe 请求并销毁文件流，请求挂死、半截文件留盘（实测）。parts 不写会被强塞默认 1000，所以显式写 `Infinity`。字段数由我们自己的循环数（`MAX_FIELDS = 100`）。
- 所有 part 必须读完或排空；提前离开循环一律走 `abandonRequest`：响应写完后摘掉 busboy、排空剩余字节，`ABANDON_GRACE_MS`（2 秒）内收不完才销毁。**不能写完就 destroy，也不能带 `Connection: close`**——接收缓冲有未读数据时关 socket 会发 RST，客户端连错误响应都收不到（实测）。
- `inject` 看不见 socket 层问题，连接/关停行为靠 `media-socket.test.ts` 的真端口用例守。
- 路径判断一律走 `lib/safe-path.ts` 比真实路径（junction 能绕过字面比较，实测）。
- `index.ts` 设了 `forceCloseConnections: true`：SSE 永不空闲，默认值下 SIGINT 会一直等。

**Task 4.5 定下的 WhisperX 约定**，改转写或体检前必读：
- hypit **不会自己拉起**本地托管程序（runtime-local 注明 `programs up` 是显式步骤）。服务停着时 `transcribe` 两秒就失败、只报 `fetch failed`，重启电脑后必然如此。所以转写前走 `hypit/whisperx-service.ts` 的 `ensureWhisperX`。
- `programs up` 起不来时**不抛错**，正常输出 `ok:false, ready:false` 并以退出码 1 结束；`runHypit` 不看退出码，必须自己核对 `ok` 与 `ready`。
- 即便服务已在跑，`programs up` 也要约 18 秒，所以先探 `/health`；冷启动实测 78 秒到 3 分钟。
- 探测只有 `ECONNREFUSED` 算没在跑；连接被重置、回的不是 HTTP、超时都算端口被占/服务卡死，拦截，不去 `programs up`（它只会回 unchanged）。
- `programs` 要从工作目录解析 Runtime Profile，给用户的修复命令必须带 `--workspace`。

**Phase 4 收口（2026-09-22）**：四步走全过。
- Code Review：交付清单四项齐；范围外改动三处均有出处（设置页随共用字段改卡片、`forceCloseConnections`、后端重启时同步模板状态）。关键文件实际落在 `web/src/pages/steps/`（沿用 Phase 3 目录），不是本节写的 `pages/template/`。
- 测试：web 112 / server 183，关键修复均做过变异验证。`workspace.contract.test.ts` 在 Task 4.3 审查时偶发失败过一次，之后全套连跑 8 遍未复现，**留观**；它失败时会带出 hypit 原文。
- 编译：前后端 `tsc --noEmit` 零错误，`pnpm build` 通过，eslint 0 error。
- 功能：临时数据根下真浏览器实跑 AC-004（30 秒人声：四步全勾，transcript 32 词带词级时间，3 张拼图，自动进 ②）、AC-005（200 秒：探测红「时长超过 180 秒（实际 200.0 秒）」，未跑转写抽帧，agent_jobs 为 0）、AC-006（坏链接：下载红 + yt-dlp 原文 + 改为上传后跑通）；刷新不丢；用户在正式数据上复测无问题。

**Task 4.3 遗留（不挡 Phase 4）**：
- 超过 500 MB 的文件要整个读完才回 413（插件截断后仍消费剩余字节）。4.4 前端选文件时就校验大小挡住；要彻底解决得在 truncated 时走 `abandonRequest`。
- SIGINT 时正在传的上传被掐断，`process.exit` 可能抢在清理前，半截文件留在 uploads/，由启动时 `purgeStaleUploads`（>24 小时）兜底。
- 大文件写盘途中失败（如 ENOSPC）且已开始解析的路径没有真端口用例；修复代码与字段超限共用，已由后者守住。

**交付内容**：
- 实现上传（≤500 MB，流式落盘）与链接导入（`hypit media prepare-fetch` / `fetch`）
- 实现证据流水线：probe → 时长 3-180 秒校验 → transcribe（本地 WhisperX）→ tiles；每步状态与耗时经 SSE 推送，单步可重试，单步 10 分钟超时
- 实现 ①参考 页面：链接 / 上传分段控件、模板名、语言、复刻备注、Agent 模型下拉（此阶段只有内置订阅档案）、右侧播放器与四步清单
- 提供参考视频的本地流式播放接口（支持 Range）

**关键文件**：
- `clone-studio/server/src/routes/reference.ts`、`server/src/services/evidence.ts`
- `clone-studio/server/src/routes/media.ts` — 带 Range 的文件流，路径限数据根目录内
- `clone-studio/web/src/pages/template/ReferenceStep.tsx`、`web/src/components/EvidenceList.tsx`

**验收标准**：
- AC-004、AC-005、AC-006 通过
- 刷新页面后清单状态不丢

---

## Phase 5: Agent 任务运行器与过程抽屉（REQ-003，Design-Brief §A）

**交付内容**：
- 实现运行器：Agent SDK `query()`，cwd = 工程目录，hypit skill 以插件预置（数据根下的 `agent-plugin/`，从 `hypit-main/skills/hypit` 复制，经 `plugins` 选项加载，`skills: ["clone-studio:hypit"]` 只放行它——`settingSources: []` 下 `.claude/skills` 不会被读，实测 `scripts/spike-plugin-skill.mjs`），完整工具集，系统提示注入"出片由宿主负责"与当前可用生成能力清单
- 实现硬拦截（Spec v1.9 改定）。**主手段是 `PreToolUse` hook**：先于一切权限检查执行、`bypassPermissions` 下照样生效、子 Agent 里的调用也经过它。会话用 `permissionMode: "bypassPermissions"`（+ `allowDangerouslySkipPermissions: true`）让 Bash 等完整能力在无头下直接可用，拦截全靠 hook。子 Agent 工具 `Agent`（旧名 `Task`）两个名字都列进 `disallowedTools` 作第二道。拦截目标仍是两条：任何 `hypit build` / `hypit result` 写操作（任何写法）；写入路径不在工程目录前缀内。
  - 2026-09-22 实测（`scripts/spike-hook.mjs`）：普通 Bash 放行；`node …/hypit.mjs build`、裸 `hypit build`、Write 越界、子 Agent 里的 build 全部被拦且未执行。**不用** `disallowedTools` 作主手段：禁 `Bash` 拿走完整能力，`Bash(hypit build *)` 只匹配字面写法（官方文档注明）
- 会话必须传 `settingSources: []`。不传会连用户本机 `~/.claude` 的权限规则与 hooks 一起继承，行为不可复现（Phase 0 实测消息流里出现 `system:hook_started`）
- 拦截记录由宿主自己写，不读 SDK 的 `permission_denials`——用 `disallowedTools` 隐藏工具时该字段恒为空数组
- 实现熔断：45 分钟墙钟、$5 等价花费、同命令连续失败 5 次、10 分钟无消息；订阅限流进"等待额度"并到点自动 resume。花费熔断用 SDK 原生的 `maxBudgetUsd` 选项 + `error_max_budget_usd` 结果子类型，不自己累加；读 `total_cost_usd` 只取最新一条 `result` 消息，resume 的会话会续上转录里保存的累计值（Phase 0 实测 0.0518 > 0.0479）
- 实现调度器：Agent 并发上限（默认 2）、排队、取消、中止、继续（resume）、重跑（清 Agent 产物）
- **停一个在跑的会话用 `interrupt()`，不用 AbortController**（2026-09-23 实测 `scripts/spike-interrupt-cost.mjs`）：
  流式输入模式下 interrupt 立刻回一条带 `total_cost_usd` 的 result，Bash 起的子进程也被带走，1 秒后工作目录就能删；
  直接 abort 要 7 秒才抛、拿不到 result（这次运行的花费就丢了），子进程还活到自己结束、一直攥着工作目录。
  Claude Code 进程由宿主自己 spawn（SDK 的 `spawnClaudeCodeProcess`）并登记进 `procs`，后端退出时统一收尸；
  interrupt 10 秒没回 result 就兜底硬停并连子孙一起强杀
- 消息全量落 `agent_messages`，SSE 推送，刷新后补发历史
- 抽屉取数按 `routes/agent-jobs.ts` 文件头写的顺序：**先订阅 SSE 再拉快照**，且**每次连上**（含自动重连）都重拉一次
  `GET /api/agent-jobs/:jobId` 对 seq、再按 `afterSeq` 补齐——`agent-message` 事件不进重放缓冲，断线期间的消息没人会再通知
- 分页两个方向分开看：`hasNewer` 用 `afterSeq = nextSeq` 往后拉，`hasOlder` 用 `beforeSeq = firstSeq` 往前翻；
  游标只认 `nextSeq`（空页时它原样还回你传的值；往前翻的页恒为 0，那种页不能推游标），`jobLastSeq` 只用来判断追平没有——拿它当游标会跳过被截短的那段
  （Task 5.3 复审 S1-M1 / S1-M7，`routes/agent-jobs.ts` 文件头有可照抄的循环）
- 「用时」只认一条公式，所有状态都成立：`runElapsedMs + (status === "running" ? now - runStartedAt : 0)`。
  `runElapsedMs` 是这次运行之前几段已经跑掉的毫秒数，`runStartedAt` 只表示**当前这一段**的起点、永不挪动；
  等额度和排队都不在 running 状态，用时自然冻住，既不虚高也不会出现负数（Task 5.3 复审 S1-M3 / S1-M8 / S1-M1(r6)）。
  一个时间戳表达不了「冻住」——不挪一路虚高，按计划预先挪就变成未来时间、用时显示负数，所以落成了累计列
  `agent_jobs.run_elapsed_ms`（迁移 version 5）。5.4 照抄这条公式即可，别自己用 `now - runStartedAt`。
  两个注意：服务端时间戳配浏览器 `now`，客户端时钟慢的话 running 那段会算出负数，外面套一层 `Math.max(0, …)`；
  后端崩溃留下的「运行中」被重启标成中断时，那一段的时长无从得知、只会记成 0，终态行上 `runElapsedMs === 0`
  但 `runStartedAt` 非空时显示「—」比「0 秒」诚实（Task 5.3 复审 S1-L1(r7)）
- 一次拉一页的内存上限是「4MB 预算 + 最后那一条」：单条消息本身不截断（Spec 要求全量存），
  所以一条几百 MB 的工具输出仍会整条进内存，真遇到要在写入侧限（Task 5.3 复审 S2-L10）
- 没有「取消任务」的 HTTP 接口：抽屉只给「中止」，删对象走删除流程；Phase 8 的变体队列要「取消排队中的变体」
  （Spec 第 167 行）时再加回来（Task 5.3 复审 S2-L3）
- 删除失败回滚后，还没起会话就被停掉的任务是「已取消」而不是「中断」（没有会话可 resume），界面上只给「重跑」（Task 5.3 复审 S1-L1）
- 实现右侧抽屉：顶栏（状态、模型、用时、花费 / 上限、中止）。「用时」按本次运行算（继续 / 重跑各自重新计时，等额度续跑算同一次），
  不是从任务第一次开始算：库里的 `started_at` 保留的是第一次开始的时间，显示时以当前这次运行为准
  （Task 5.2 第四轮复审 S2-L12），算法照上面那条公式，别自己拿 `runStartedAt` 减、待办清单、markdown 逐字流式、工具调用折叠行、长输出折叠、错误红竖线、拦截琥珀竖线、结束卡
- 实现熔断 / 中断横条 CMP-009
- 抽屉的两处实现取舍（Task 5.4）：
  - 「逐字流式」在前端做：会话没开 SDK 的 `includePartialMessages`，消息是整条落库、整条推的（开了会把每个
    增量都落成一行、推一次事件）。抽屉只对打开之后才到的回复逐字显示（0.6 秒内流完：Spec 要求产生到显示 ≤1 秒，
    落库、推送、拉取已占掉一截），快照里的历史整段显示，不重放；抽屉收起时内容照样挂着，展开不会重打一遍；
    流到第几个字按经过的时间算、不按定时器跳了几下算（后台标签页定时器被压到一秒一跳，按跳数会拖成半分钟，真机实测）；
    尊重 prefers-reduced-motion
  - 顶栏要「档案名与模型 id」（REQ-010），`AgentJobView` 补了 `profileName`（`agent_jobs.profile_name` 已有，
    档案功能落地前恒为 null，界面只显示模型 id；没指定模型写「订阅默认模型」）。「熔断上限」取设置页的
    `agentBudgetUsd`，不另开接口
  - 「用户消息」（任务提示 / 继续 / 打回意见）：会话走流式输入，SDK 不回显，宿主在每段运行开跑时记一条
    `host_prompt`（kind：start / continue / auto_resume，Spec v1.9.1）。抽屉按它画「继续运行」「额度恢复，自动继续」
    分隔，不再数 `system:init`
  - 被宿主停下（中止、取消、熔断、限流）的那段：调度器自己记一条 `host_stop`（reason 同 stop_reason 写法，限流为
    `awaiting_quota`）。抽屉据此把这一段收尾的 result 红块换成中性的「会话在这里被停下：原因」，每一段都认；
    不去猜被停时 result 的字段——那是 SDK 的事，从没真机录过（复审 S1-N1）。没有这条记录的出错 result 照常红块
  - 已知局限（Task 5.4 复审记下，暂不处理）：待办清单只从已加载的消息里找最近一次 TodoWrite，长会话的最后一次
    TodoWrite 早于首屏那页时，要往上翻才会出现；顶栏「熔断上限」显示的是设置页当前值，运行中改了设置，
    这次运行实际仍按开跑时的预算走；`host_stop` 是这次才加的，之前被中止过的任务没有这条记录，
    它们收尾的 result 仍按红块显示（不回填）
  - 宽度：默认也是最窄 420（§A.5「≤360 不允许」）；视口 ≥1600 才能拖到 640（§8.3），分隔条可键盘左右键调，
    点击区 28px（§5.3）居中压在边框上；能拖宽时抽屉左边让出 14px 空隙，拖动区的左半落在空隙里，
    不盖旁边页面的滚动条（复审 S1-R3-1，真机 elementFromPoint 核过）
  - server 测试加了 `vitest.config.ts`（testTimeout 20 秒）：`pnpm run check` 两套测试并行、机器上开着 dev server 时，
    路由测试每个文件第一个用例的冷启动（重新 import fastify 整条链）会拖过默认 5 秒，单独跑全绿

**Task 拆分（2026-09-22）**，按序做，每个走 review→fix 循环：

| Task | 内容 | 覆盖 | 状态 |
|---|---|---|---|
| 5.1 | 运行器核心：server 接入 SDK、会话配置（`settingSources: []`、cwd、预置 hypit skill、`bypassPermissions` + guard hook + 禁 `Agent`/`Task`）、`guard.ts` 拦截规则与宿主拦截日志、`prompts.ts` 复刻 / 变体 / 打回提示 | AC-007、guard 单测 | ✅ 五轮 review→fix；AC-007 真机通过 |
| 5.2 | 熔断与调度：墙钟、`maxBudgetUsd`、同命令连续失败、无消息卡死；订阅限流进等待额度并到点 resume；并发上限、排队、取消、中止、继续、重跑 | AC-008、AC-010 | ✅ 七轮 review→fix；限流 / 停止 / 收尸三处真机实测 |
| 5.3 | 消息全量落 `agent_messages` + SSE + 刷新补发；`routes/agent-jobs.ts`；删模板先停 Agent 进程 | AC-009、AC-002 | ✅ 七轮 review→fix 两阶段 PASS；第七轮的修复只经全量矩阵 + 变异测试自验，第八轮复审被中止未出结果 |
| 5.4 | 右侧抽屉：顶栏、待办、markdown 逐字流式、工具折叠行、长输出折叠、红 / 琥珀竖线、结束卡 | 设计稿 §A | ✅ 四轮 review→fix，第四轮两阶段 PASS（只剩 LOW，见下）；真机（隔离数据根 + 真服务端与调度器 + 脚本化假会话，零花费）验过逐字流式、折叠展开、中止、刷新补历史、540 条长历史往前翻、已取消结束卡、宿主停下的中性线、拖宽不压滚动条 |
| 5.5 | 熔断 / 中断横条 CMP-009（继续 / 重跑） | CMP-009 | ✅ 两轮 review→fix，第二轮两阶段 PASS（只剩 LOW，见「给 Phase 6 的交接」）；AC-008 / AC-009 / AC-010 真机通过（真 Agent，等价花费 $0.477）；AC-002 真机转 Phase 13 |

**给 5.5 的交接（Task 5.4）**：
- 横条上的动作照 `web/src/lib/agent-status.ts` 的 `nextActions(status)` 给：熔断 / 中断 / 失败 = 继续 + 重跑，已取消只给重跑，
  完成的什么都不给；抽屉结束卡已按它写了说明文字，按钮只放横条（Design-Brief §A.3）。接口 `POST /api/agent-jobs/:id/continue`、`/rerun` 已有
- 原因文字用同一个 `describeStop(job)`，用时用 `formatRunElapsed(job, now)`（含「—」规则），别另写一套
- 点完动作拿回的任务状态交给抽屉：`AgentFeed.replaceJob(view)`；重跑出来的是新任务，模板主题的 `agent-job` 事件会让抽屉自己换过去
- 第四轮复审留下的 LOW（不影响功能，择机处理）：≥1600 宽屏时抽屉左侧那 14px 空隙露出应用底色，横贯主区的边线在那里断开；
  拖动区右半压在抽屉最左 14px 上，带竖线的工具行最左侧那点按下去是拖宽不是展开；收起后的窄轨约 45px 宽、显示状态点，
  Design-Brief §2.1 写的是「32px 窄轨显示运行中任务数」；前端 JS 单包 764KB（highlight.js 常用语言全集，可改成只注册用到的语言）

**Task 5.5 的实现与真机验收（2026-09-23）**：
- 横条 `web/src/components/BreakerBar.tsx`（CMP-009）挂在模板页步骤条下方、工作区上方（`TemplateLayout`），只在任务已熔断 /
  失败（红）、中断 / 已取消（灰）时出现；动作照 `nextActions`，重跑走普通二次确认（新 `ui/ConfirmDialog.tsx`，§6.1），
  写明会删掉 Agent 在工作目录顶层写出的文件，references / assets / productions 三个目录整个保留（与 `resetAgentProducts`
  只清顶层的实际行为一致——Agent 若往这三个目录里写过东西，重跑也不会清掉）
- 横条与抽屉共用一份任务数据：`lib/AgentFeedProvider.tsx` 挂在外壳上，`useTemplateAgent()` 取；全页只有一个任务取数、一条任务主题 SSE
- 真机验收（隔离数据根 + 真服务端 + 真 Agent，订阅登录、未设 API key；等价花费合计 $0.477，未超 $0.5）：
  AC-008 分两个任务证明（复审 S1-M2）：任务 A（Opus，预算 $0.2）真熔断在 $0.27，点横条「继续」接回同一会话（会话 id 不变）——
  但它在第一个工具执行前就熔断了，没有写出过中间文件；「熔断后中间文件保留」由任务 B（Haiku，预算 $0.05）证明：
  写出 notes.md 后熔断，继续后 Agent 读回了它。两个性质都在真机上成立，只是没在同一次 $0.2 运行里同时出现；
  AC-010 强杀后端再重启 → 任务标「中断 · 后端重启」、用时「—」，点「继续」接着跑、会话 id 不变，Claude Code 子进程随后端一起退出、
  没有孤儿进程（当场按进程树核过）；AC-009 运行中刷新，历史补回、之后的消息继续推送进来；
  AC-007 本轮没能在真机上复现（两次都在执行到 build 那一步之前熔断），拦截的自动化测试已复核，真机结论沿用 5.1；
  **AC-002 没有端到端真机证据**：5.3 当时只有自动化测试（先前写「沿用 5.3 真机结论」有误，复审 S1-M1 指出）。
  本轮补跑一次：任务运行时删除影响接口如实报「1 个运行中的任务」，但 Agent 在删除前自己跑完了，
  「运行中删除 → 进程先停 → 再删目录」这一步没测成；花费已到上限，没有再跑。现有证据是删除流程与停进程的自动化测试
  （deletion / scheduler-stop / Sidebar 确认框）加 5.3 spike（中止后 1 秒工作目录即可删除）。Phase 13 端到端验收时补真机
- 真机顺带发现并修掉：SDK 思考时连推 `system:thinking_tokens`，「思考中 · Ns」原来拿最后一条消息计时、被拨回 0:00，
  改为从最后一条看得见的活动算（`lastActivityAt`）

**给 Phase 6 的交接（Task 5.5）**：
- ② 复刻页直接沿用 `BreakerBar`（它已经挂在模板页工作区上方，所有步骤都看得到），不另做一个；
  任务数据用 `useTemplateAgent()`，不要在页面里再开一份 `useAgentFeed`
- 复刻任务由导入完成后自动启动：现在界面上没有发起任务的入口，真机验收用的是临时启动器里的一个入队路由
- 真机上 Opus 一轮调用的等价花费约 $0.04～0.27（首轮带系统提示与 skill 最贵），熔断上限太低会在工具执行前就停下
- 5.5 第二轮复审留下的 LOW（不影响功能，择机处理）：同一任务「同状态再停下」且客户端没看到中间的运行态时，横条的
  请求状态 key（id + status）不变，旧的「继续失败」原文会留着——key 加上 `endedAt` 即可；忙碌时按钮禁用与原因提示没有测试钉住；
  重跑确认框是 role=status 横条的子节点，读屏可能把整个对话框内容当状态播报，挪成兄弟节点更干净；
  `ConfirmDialog` 与 `ConfirmDangerDialog` 的 dialog 外壳重复，可抽公共外壳

**给 Phase 7 的交接（Task 5.4）**：「打回并写意见」要在 `host_prompt` 里分出单独的 kind（如 `rework`，现在只有
start / continue / auto_resume，`continueJob(jobId, note)` 区分不了打回和普通继续），抽屉按它画「打回意见 #n」
带序号的分隔（Design-Brief §A.1），现在的分隔写的是「继续运行」。

**关键文件**：
- `clone-studio/server/src/agent/runner.ts` — SDK 会话生命周期
- `clone-studio/server/src/agent/guard.ts` — PreToolUse hook 的拦截规则（纯函数，可单测）
- `clone-studio/server/src/agent/breaker.ts` — 熔断与卡死检测
- `clone-studio/server/src/agent/prompts.ts` — 复刻 / 变体 / 打回的系统提示与任务提示
- `clone-studio/server/src/agent/scheduler.ts`、`server/src/routes/agent-jobs.ts`
- `clone-studio/web/src/components/agent/AgentDrawer.tsx`、`agent/MessageStream.tsx`、`agent/ToolRow.tsx`、`agent/TodoList.tsx`
- `clone-studio/web/src/components/BreakerBar.tsx`（CMP-009）

**验收标准**：
- AC-007、AC-008、AC-009、AC-010 通过；AC-002 自动化通过，真机转 Phase 13（见 Task 5.5 的真机验收说明）
- `guard.ts` 有单元测试覆盖：`hypit build`、`node …/hypit.mjs build`、PowerShell 与 bash 两种写法、越界写路径
- 有一条测试钉住会话配置：必须挂上 guard hook、`disallowedTools` 必须含 `Agent` 与 `Task`、不得禁 `Bash`（那会拿走完整能力）

---

## Phase 6: 复刻、估价闸门与出片（REQ-004 前半、REQ-006、REQ-009，设计稿"② 复刻"）

**交付内容**：
- 导入完成后自动启动复刻任务；完成判据：`reference.svrun` 存在、`hypit check --json` 通过、`ANALYSIS.md` 与 `TIMELINE.md` 存在
- 实现 ②复刻 页面：分析摘要、时间线（点时间码联动参考播放器）、校验结果三个折叠区，随文件产生逐个出现
- 实现花钱闸门。**估价由 Clone Studio 自己算，hypit 给不出数**：Phase 0 实测 `pricing.kind` 只有 `page`（一个价格页 URL）与 `local`（零价）两种，无任何结构化费率，官方文档明言 "Hypit itself calculates no total"。做法：自维护一张"能力/模型 → 单价"费率表（设置页可编辑），用 `plan --json` 的 `needs[].summary.fields`（宽高、`startFrame`/`endFrameExclusive`、帧率、采样率）与 `providerRequestCount` 计算；闸门界面同时展示 `providers[].pricing.url` 价格页链接供人工核对费率表是否过期
- 单条限额与批次限额判定；估价拿不到（plan 失败、Provider 无价目、费率表缺该能力单价）一律按超限处理；plan 有未解析请求则失败并指明缺哪种能力
- **build 的实际花费拿不到**：Result 只有不含金额的 `receipt: { id, url? }`，全仓库无任何金额字段。生成侧花费一律按"请求数 × 自维护单价"记账并标"估"，界面不出现"实际账单"字样；有 `receipt.url` 时给链接让人去 Provider 侧查真账单
- 判 build 成败看 `result.outcome` / `result.state`，**不能看 `work.state`**：Phase 0 实测失败的 build 也是 `work.state: "done"` 配 `result.outcome: "failed"`。`failure` 是一整段人类可读文本而非结构化错误码，界面原样展示
- 出片前宿主重新生成工作目录的 `hypit.runtime.json` 与 `.hypit/runtime`，不信任 Agent 会话之后留下的版本（Spec REQ-003，Task 5.1 第三轮复审）
- `get` 导出到 `output/` 时，要把 `output` 加进 `hypit/workspace.ts` 的 `WORKSPACE_DIRS`：那份常量同时是重跑时的保留清单，
  不加的话第一次重跑就会把已经导出的成片删掉（Task 5.2 第四轮复审 S2-L11）
- 实现出片执行器：`build --follow --json` + `activity --watch --jsonl` 取结构化进度，渲染并发上限（默认 1），`get` 导出到 `output/`，key 只注入 hypit 子进程环境
- 实现估价 / 限额卡 CMP-006、出片进度 CMP-007、台账写入（`builds`、AgentJob 花费）

**Task 拆分（2026-09-23）**，按序做，每个走 review→fix 循环，两阶段 PASS 后单独 commit：

| Task | 内容 | 覆盖 | 状态 |
|---|---|---|---|
| 6.1 | 复刻编排与完成判据（server）：证据准备**新完成**时自动建复刻任务（已有模板不补跑，配测试）；任务完成后宿主自己验完成判据（`reference.svrun` / `ANALYSIS.md` / `TIMELINE.md` 存在 + `hypit check --json` 通过），结果落库；判据不过标失败并给原因；建 replica production；`GET /api/templates/:id/clone` 给 ② 页的文件与 check 结果、`POST` 同路径给从没有过任务的模板手动开始；复刻任务运行中拒绝换参考视频；可用能力清单进系统提示（REQ-006，Phase 5 已实现，`prompts.ts` `capabilitySection`） | REQ-004 行为、FLOW-002 步骤 3-4 | ✅ 四轮 review→fix，第四轮两阶段 PASS（只剩 1 条 LOW，转 6.4）。变异自检 27 条全杀（独立拷贝里跑）；真机：审查员用真实库备份起当前代码，3 个停在复刻中的老模板没有被补跑 |
| 6.2 | ② 复刻页（web）：左 60% 分析摘要 / 时间线（时间码点击联动参考播放器）/ 校验结果三个折叠区，随文件产生逐个出现；右 40% 参考视频小播放器 + 估价卡位；运行中「复刻进行中」+ 用时 / 花费 / 模型；熔断沿用 `BreakerBar`、任务数据用 `useTemplateAgent()`；加载 / 空 / 错误态 | SCREEN-004 | ✅ 两轮 review→fix，第二轮两阶段 PASS（6 条 LOW，5 条已修）。审查员在独立端口起服务按设计稿逐值比对（1440 / 1280 + 抽屉）；变异自检 33 条全杀（独立拷贝） |
| 6.3 | 估价与花钱闸门：费率表（能力 → 单价，设置页可编辑）；`plan` / `pricing` 解析成估价（needs 字段 × 单价、请求数）；`gate.ts` 纯函数判定单条 / 批次限额，估价拿不到按超限、未解析请求直接失败；估价卡 CMP-006（明细、价格页链接、「将自动出片」或「确认出片 $x.xx」）；确认出片接口 | REQ-006 估价与规则、AC-017 / 018 / 019 | ✅ 两轮 review→fix，第二轮两阶段 PASS（首轮 2 HIGH 全修：估价途中作废不回拉、负时长不计价；第二轮 2 MEDIUM 当场修：批次已花现算、单价 4 位小数）。变异自检服务端 / 前端全杀（独立拷贝）；审查员在 4411 端口真跑 hypit plan 核过确认 / 重估 / 拿不到三条路径 |
| 6.4 | 出片执行器与台账：出片前重生 Runtime Profile；`build --follow --json` + `activity --watch --jsonl` 结构化进度；判成败看 `result.outcome`；`get` 导出到 `output/`（`output` 进 `WORKSPACE_DIRS`）；key 只进 hypit 子进程；全局渲染并发默认 1、`hyperframes.local` workers 默认改 1（Spec 同步 + 存量迁移）；失败原文完整展示、「重试出片」、失败时记可用内存；台账（builds 估价 / build-id / receipt、Agent 花费）标「估」；出片进度 CMP-007；出片进行中拒绝换参考视频（6.1 只作废未出片的复刻片，渲染中的那条要这里保护）；复刻片出片完成后模板从 `cloning` 置 `awaiting_review`（6.1 判据通过时模板仍留在 `cloning`，没有别的 Task 管这次转换）；模板卡「成片数」只数变体与已验货的复刻片（`archive.ts` `templateStats` 现在数全部 done，复刻片出完会被提前计入，与 REQ-004「通过验货时作为第一条成片」冲突） | REQ-006 出片、REQ-009、AC-020（mp4 部分） | |
| 6.5 | Phase 6 真机验收与收口：一条真实参考视频导入 → 复刻完成 → 三个区块与估价卡；出片得 mp4 并 ffprobe；限额内自动出片与超限待确认各走一次；Phase 四步验证 | Phase 6 验收标准 | |

**关键文件**：
- `clone-studio/server/src/services/clone.ts` — 复刻编排与完成判据（`clone-starter.ts` 是证据流水线调它的注册点；
  `routes/clone.ts` 的 `GET /api/templates/:id/clone` 给 ② 页 `{analysis, timeline, svrunExists, verdict, replica}`，
  文件没产生是 null，超 256 KB 截断给页面并带 `truncated`；结论只给和当前这次运行对得上的那条，完成了还没核完是 `verifying`）
  FLOW-002「check 反复不过计入卡死检测」：宿主判据未过要人点「继续」才会再跑，每次都有人把关，没有计入卡死检测（有意为之，Spec 已写明）
  结论出来时往 `template:<id>` 推一条 `clone` 事件（前端的 useSse 事件名清单要有 `clone`，6.2 加）；POST 的错误码：`NOT_CLONING` / `CLONE_EXISTS`（任务已完成时文案是「已经复刻完成」）/ `CLONE_NOT_STARTED`（工作目录自检不过，原因原样带出）
  复刻片读写在 `services/replicas.ts`（只依赖库，证据流水线换参考视频时直接作废未出片的复刻片）
  **进程教训**：用户自己的后端是 `tsx watch` 跑同一份工作区，任何源码改动都会被热重载进用户的真实服务。6.1 变异自检两次直接改了工作区源码（UTC 11:32–11:57 三轮；12:26 又一次，是改脚本那步语法错误没生效、同一条命令接着跑了旧脚本），「启动补跑」变异在真实库给 3 个老模板共起了 12 个任务（6 个起了会话，都被下一次重载标成中断，库记花费 $0；工作目录核对完好）。此后变异自检只在 scratchpad 的独立拷贝里跑，脚本拒绝指向工作区，每次前后比对工作区源码指纹
  `ensureReplica` 复用「未出片」的复刻片时也会复用 `failed` 的那条而不重新排队：这条分支 6.1 里走不到（判据通过时没有失败的复刻片），6.4 出片失败 /「重试出片」时一并定下失败复刻片是重新排队还是作废重建，并补测试
  6.1 第四轮审查 LOW（转 6.4）：一次 `hypit check` 若卡住跨过整个换参考视频、新证据做完又回到 cloning、而新一轮 `startClone` 因工作目录自检失败没起来，旧的那次核完仍会按旧产物建一条排队复刻片。6.4 给核对记一个开始时的模板 `updated_at` / 运行令牌，建复刻片前比对
- `clone-studio/server/src/services/gate.ts` — 闸门判定（纯函数 + 单元测试，AC-017 / 018 / 019）；`estimate.ts` — plan + 费率表 → 估价明细（纯函数）；
  `estimate-run.ts` — 编排：重写 Runtime Profile → plan + pricing → 估价 → 闸门 → 落 `estimates`、改出片单位状态（auto 留 queued 等 6.4 执行器 / confirm → awaiting_cost_confirm / blocked → failed），
  确认花费、重估、重启补估；`rates.ts` — 费率表读写；`routes/estimate.ts` — `GET/PUT/DELETE /api/settings/rates`、`GET/POST /api/productions/:id/estimate`、`POST /api/productions/:id/confirm-cost`。
  估价在判据通过（复刻片排上队）后由 clone.ts 触发，结论出来往 `template:<id>` 推 `estimate` 事件。
  AC-019「之后全部停」在编排层：批次里有一条因批次限额停下且未确认，后面的都停（reasons `batch_halted`）；那条确认后再估才只看数字
  前端：`web/src/components/clone/EstimateCard.tsx`（CMP-006：金额、明细、限额进度条、原因、价格页链接、「确认出片 $x.xx」/「将自动出片」、重新估价；估价还没出来时每 3 秒再看）、
  `web/src/components/settings/RatesTable.tsx`（设置页费率表增删，备注可填，无行内改价：同能力再存一次即覆盖）、`web/src/lib/estimate.ts`；`estimate` 事件也走抽屉那条 SSE。
  复刻片的估价卡不画批次进度条：Spec §6.2「Production belongs to Batch：仅 variant」，设计稿那条「批次已花」是给 ④ 变体的；页脚文案「限额内，将自动出片」（设计稿写的「素材通过后」是变体的流程）。
  估价的三处闸门（6.3 首轮审查 HIGH）：结论只改仍在 queued / awaiting_cost_confirm / failed 的出片单位，估价期间被作废的不拉回来；确认花费要求出片单位仍在待确认；按秒计价时长不是正数（Seedance 2.5 的 duration=-1 表示自动）按拿不到；plan 的 requestIssueCount > 0 / ok:false 一律 blocked；同一条不并发估两遍（in-flight 集合）。
  批次「已花」不靠 `batches.spent_usd` 累加，估价时现算：批次里其它出片单位最新一次估价已放行（auto 或已确认）的 total 之和，作废 / 失败的不算；批次限额取 `batches.budget_usd`（提交时定），没定用设置的批次限额（6.3 第二轮 MEDIUM）。
  「失败」分两种：估价 blocked 的可重估；出片失败（有 build 记录）的只能走「重试出片」，不能靠重估绕过去再花钱。补估只看 `run_path` 非空的排队项（Phase 7 变体排队等 Agent 时还没有 run）。
  6.4 / Phase 7 交接：估价 blocked 把复刻片置 failed 后，下一次判据通过 `ensureReplica` 会复用这条 failed（不重排队、不重估）——6.4 定失败复刻片是重排队还是作废重建时一并处理。设置页的分组卡片与数字项抽到 `components/settings/SettingsFields.tsx`（页面回到 300 行内）
- `clone-studio/server/src/services/build.ts` — build、进度、导出、取消
- `clone-studio/server/src/services/ledger.ts` — 花费记账
- `clone-studio/web/src/pages/steps/CloneStep.tsx`（② 复刻页：取数、刷新、参考播放器、「开始复刻」）、`web/src/components/clone/CloneSections.tsx`（三个折叠区块）、`web/src/lib/clone.ts`（数据层 + TIMELINE / ANALYSIS 解析）；`web/src/components/clone/EstimateCard.tsx`（6.3）、`web/src/components/clone/BuildCard.tsx`（6.4）
  Agent 写文件没有事件：任务在跑时 ② 页每 3 秒重拉，任务一结束立刻补拉一次，判据结论出来靠 `clone` 事件失效；右栏按设计稿 300px，1280 宽 + 抽屉时按 40% 收窄、最窄 220（6.2 审查实测 1280 下右栏比左栏还宽）；时间码列 112px 不换行（设计稿画的 84px 装 `00:00-00:03`，Agent 按提示写的 `mm:ss.s` 起止压掉 `.0` 后最长 `00:00-00:03.5` 装不下），偏差备案；等待额度复用抽屉的 `QuotaBar`（工作区一张独立蓝灰横条）；判据结论的 `clone` 事件走抽屉那条 SSE（AgentFeed.onTemplateEvent），页面不另开连接；熔断横条的请求状态按「任务 + 状态 + 结束时刻」重置（6.1 首轮 L7）；「手动开始复刻」与 ① 的「开始复刻」提交按钮区分开
  6.2 留给后面的 LOW：Agent 快照读失败后「重试」期间按钮无进行中反馈、`new Error(agent.error)` 丢了状态码（模板已删也显示不出「不存在」），要 FeedState 带原始错误对象；审查员在无头 Chrome 里发现每个模板页 3 条 SSE（global、template、加上 job 后重开的 template+job），导航离开后旧 socket 会挂 15–45 秒，Chrome 同主机 6 条上限一满，`/agent-job` 就 5 秒超时（页面已有错误态 + 重试）。属 Phase 5 的 SSE 层，6.5 真机在普通 Chrome 里核一次；可能的修法是 jobId 变化时不重开模板那条 EventSource


**验收标准**：
- 一条真实参考视频走到复刻完成，三个区块与估价卡出现
- AC-017、AC-018 的判定逻辑由 `gate.ts` 单元测试覆盖
- AC-020（出片得到可播放 mp4）：本地渲染 2026-09-23 复测可用（见「已知风险」），按正常验收；出片执行器要把失败原文完整展示、
  支持「重试出片」，渲染并发保持 1，失败时记下当时可用内存

---

## Phase 7: 模板验货（REQ-004 后半，设计稿"③ 验货"）

**交付内容**：
- 复刻片的 `productions`（kind=replica，带 version）在 Task 6.1 判据通过时已建；这里做「通过验货」时把它作为该模板第一条成片（REQ-004）
- 实现并排同步播放器 CMP-004：共享进度条、播放 / 暂停、倍速、逐帧、声音来源切换、任一路缓冲两路同停、9:16 按高适配不拉伸
- 实现版本切换、时长差与分辨率差、底部固定操作区
- 实现"打回并写意见"：意见 resume 原 Agent 会话 → 重新 check → 重新过闸出片 → 新版本
- "通过验货"后模板状态置已验货并解锁 ④变体

**关键文件**：
- `clone-studio/server/src/routes/review.ts`
- `clone-studio/web/src/pages/template/ReviewStep.tsx`、`web/src/components/SyncPlayers.tsx`

**验收标准**：
- AC-011、AC-012、AC-013 通过

---

## Phase 8: 批量变体与素材审核（REQ-005，设计稿"④ 变体队列""④ 素材审核"）

**交付内容**：
- 变体的"重跑"要清掉 Agent 下载的素材：`resetAgentProducts`（Task 5.2）对模板工作目录保留 `assets/`——那里可能有用户替换过的图。
  变体的 Agent 产物主要就在 `assets/` 加 `SOURCES.json`，重跑时要按 `SOURCES.json` 或库里的"用户已替换"标记只删 Agent 抓来的那部分（Task 5.2 复审 S1-M4 记下）
- 模板重跑与变体任务互斥：调度器的"一个对象一个任务"只管同一个 owner，模板重跑会删掉 `reference.svml` / `.svrun`，
  而正在跑的变体 Agent 正读着它们。Phase 8 要在模板重跑前把该模板下的变体任务也算进"未结束任务"（Task 5.2 复审 S2-L7）
- 实现批量提交：多行 brief 解析与校验（空行忽略、5-500 字、1-20 条）、批次记录、每条复制模板源文件到 `productions/<id>/` 并入队
- 变体 Agent 提示：基于模板改台词 / 条目 / 提示词，联网找图并统一裁切，写 `SOURCES.json`，缺口显式标注，写到 check 通过
- 实现变体状态机：排队 → Agent 写稿 → 素材待审 → 待确认花费 → 渲染中 → 完成 / 失败 / 已取消，接入 Phase 6 的闸门与出片；批次累计达限额后其余全部停在待确认
- 实现 ④变体 页面：提交区（行号文本框、示例 brief、目标语言、模型下拉、批次限额）、按批次分组的紧凑队列、需处理行置顶带色边、五个筛选
- 实现素材审核全幅面板：素材卡 CMP-005（已替换 / 无来源 / 缺口角标、看大图、替换上传）、台词全文、估价卡、打回、取消、素材通过（有缺口时禁用）、版权提示
- 失败行就地展开错误原文，提供"重试出片"与"重跑"

**关键文件**：
- `clone-studio/server/src/routes/batches.ts`、`server/src/routes/productions.ts`、`server/src/routes/assets.ts`
- `clone-studio/server/src/services/variant.ts` — 变体编排与状态机
- `clone-studio/server/src/services/assets.ts` — SOURCES.json 解析、替换图规格化（保持文件名与尺寸）
- `clone-studio/web/src/pages/template/VariantsStep.tsx`、`web/src/pages/template/AssetReviewPanel.tsx`
- `clone-studio/web/src/components/BriefEditor.tsx`、`web/src/components/AssetCard.tsx`

**验收标准**：
- AC-014、AC-015、AC-016、AC-018、AC-019 通过
- 一个已验货模板提交 3 条 brief，全程只在素材审核处人工介入，至少 2 条产出 mp4

---

## Phase 9: 成片库、下载与花费明细（REQ-007、REQ-009，设计稿"⑤ 成片"）

**交付内容**：
- 实现 ⑤成片 网格：封面帧（ffmpeg 抽帧）、名称就地改、时长、花费、状态、筛选、多选
- 实现播放弹层与花费明细 CMP-008（Agent 任务与 Build 两张表、"估"徽标、合计）
- 实现单条下载与多选打包 zip；成片删除（连带文件）
- 模板页头与客户页显示累计花费

**关键文件**：
- `clone-studio/server/src/routes/outputs.ts`、`server/src/services/thumbs.ts`、`server/src/services/zip.ts`
- `clone-studio/web/src/pages/template/OutputsStep.tsx`、`web/src/components/OutputCard.tsx`、`web/src/components/CostBreakdown.tsx`

**验收标准**：
- AC-020、AC-021、AC-024 通过

---

## Phase 10: Agent 模型档案与切换（REQ-010）

**交付内容**：
- 实现模型档案的增删改与默认设置；内置"本机 Claude Code 订阅"不可删；预设：Anthropic API key、DeepSeek（`https://api.deepseek.com/anthropic`，默认支持看图）、豆包方舟（端点联网核实后写入，核实不到则只留自定义）、Gemini / OpenAI（经用户自起的 LiteLLM，预填 `http://127.0.0.1:4000`）、自定义
- 运行器按档案给 SDK 会话注入 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL` 及三档默认模型映射；不同任务互不串环境
- 实现"测试连接"（声明支持看图时带一张测试图）；无原生搜索的档案在系统提示里改用 Bash / WebFetch 找图
- 复刻任务拦截不支持看图的档案；resume 沿用原档案，重跑可重选；AgentJob 存档案名与模型 id 快照；$ 熔断按档案单价折算
  - 交接（Task 5.5）：「重跑可重选模型」（CMP-009）这次没做——现在只有内置订阅档案。做档案时给 `POST /api/agent-jobs/:id/rerun`
    加可选的档案参数，`BreakerBar` 的重跑确认框里放 CMP-010 选择器，默认选原档案
- 设置页"Agent 模型"分区与添加面板；①参考 与 ④变体 的模型下拉 CMP-010 接入真实档案

**关键文件**：
- `clone-studio/server/src/routes/model-profiles.ts`、`server/src/agent/profiles.ts` — 档案到环境变量的映射与预设
- `clone-studio/server/src/agent/runner.ts` — 修改：按档案注入环境与系统提示分支
- `clone-studio/web/src/pages/settings/ModelProfiles.tsx`、`web/src/components/ModelSelect.tsx`（CMP-010）

**验收标准**：
- AC-025 至 AC-030 通过

---

## Phase 11: Codex 订阅生图 Provider（REQ-011，P1）

**交付内容**：
- 参照 `hypit-main/examples/provider-package/packages/provider-images` 写项目自有 Provider，承接 `@hypit/gpt-image@1#gpt-image-2`：`start` 里 spawn `codex exec`（参数、Windows 沙箱、`NODE_OPTIONS` 清理、`$imagegen` 单次、10 分钟超时、4 MB 行缓冲全部按 Spec REQ-011），`collect` 经 `context.resources` 交回 PNG；两条找图路径互为兜底；零价 pricing
- hypit 调用统一追加 `--package-root <clone-studio>/providers`；启用后 runtime profile 写入 endpoint 与 `bindings`
- 设置页增加 Codex 体检行、启用开关、"试出一张图"；台账记录张数

**关键文件**：
- `clone-studio/providers/codex-image/package.json`、`providers/codex-image/src/activation.ts`、`providers/codex-image/src/provider.ts`
- `clone-studio/providers/codex-image/src/codex-runner.ts`、`providers/codex-image/src/jsonl.ts`、`providers/codex-image/src/locate-image.ts`
- `clone-studio/server/src/hypit/workspace.ts` — 修改：bindings 与 package-root
- `clone-studio/web/src/pages/settings/CodexImage.tsx`

**验收标准**：
- AC-031、AC-032、AC-033 通过
- Provider 自带的生命周期测试不发真实请求即可跑过

---

## Phase 12: 生视频通道切换（REQ-012）

**交付内容**：
- 创建 `video_channels` 表；`templates` 加 `default_video_channel`，`builds` 加 `video_channel`、`video_model`（migration）
- 实现通道注册表与 runtime profile 生成：按所选通道写 endpoints 与 `bindings`；同模型换通道只改 bindings
- 实现跨模型换通道：resume 该条 Agent 会话执行"改用某模型"短任务 → check → 过闸门
- 联网核对 MiniMax 官方视频生成 API 后，写 `minimax-cloud` Provider（提交、轮询、取文件、pricing、错误原文保留、不发真实请求的生命周期测试）
- 设置页"生视频通道"分区；③验货 重出复刻片、④变体 提交区、成片重试出片的通道下拉；版本控件与花费明细显示通道
- 按 `docs-inbox/minimax-h3-comfyui.md` 写 `minimax-comfyui` Provider：上传 → 提交 → 轮询 → 取视频 → 验真；R2V 与 FL2VA 两种工作流图；GPU 锁并发 1、与 WhisperX 互斥；超时按片长算且超时不重提；工作流落盘与指纹找回；重启丢历史的明确提示；取消双接口；假 fetch 回放的生命周期测试含三条失败路径
- 按 `docs-inbox/即梦CLI-dreamina使用文档.md` 写 `jimeng-cli` Provider：`dreamina` 提交 → `query_result` 轮询 → 下载；提交前本地校验时长/分辨率/比例；授权与限流两类错误分别处理；体检读 `user_credit`；台账记积分消耗
- 文档标【未验证】的能力在界面与 Agent 系统提示里标"未验证"
- 把已启用通道及其模型限制写进 Agent 系统提示

**关键文件**：
- `clone-studio/server/src/video/channels.ts` — 通道注册表、可用性与限制描述
- `clone-studio/server/src/routes/video-channels.ts`
- `clone-studio/server/src/hypit/workspace.ts` — 修改：按通道生成 bindings
- `clone-studio/server/src/services/switch-model.ts` — 跨模型换通道的 Agent 短任务
- `clone-studio/providers/minimax-cloud/src/provider.ts`、`providers/minimax-cloud/src/activation.ts`
- `clone-studio/providers/minimax-comfyui/src/provider.ts`、`clone-studio/providers/jimeng-cli/src/provider.ts` — 依据 docs-inbox/ 两份文档
- `clone-studio/web/src/pages/settings/VideoChannels.tsx`、`web/src/components/ChannelSelect.tsx`

**验收标准**：
- AC-034 至 AC-038 通过；四个通道的 Provider 生命周期测试全部通过；本地 ComfyUI 与即梦两个通道各用真实环境出过至少一段视频，或在报告里写明因何未能实测

---

## Phase 13: 可靠性收尾与端到端验收

**交付内容**：
- 崩溃恢复全链路复测：杀后端、断电式重启后任务标"中断"可继续，无孤儿子进程
- AC-002 真机补验（Phase 3 延到 Phase 5、Phase 5 再延到这里，别再漏）：任务运行中删除模板 → 确认框写「将中止 1 个任务」→
  Agent 进程已结束再删目录。Agent 的活要用挪不到后台的前台负载（如 1 秒一次 echo 循环 120 次）——Claude Code 会拒绝
  单独的 `sleep`，Agent 会改成后台任务 + Monitor 然后收尾，删除时任务已结束；同时核对 Agent 起的后台任务（local_bash）
  随 Claude Code 进程一起结束
- 补齐各页六态（加载骨架、空、错误原文、禁用原因）、键盘可达与焦点环、`prefers-reduced-motion`
- 生产模式：`pnpm build` 后由后端托管前端，`pnpm start` 单命令启动；写 `clone-studio/README.md`（安装、启动、LiteLLM 起法、常见体检问题）
- 按 Spec §9 跑端到端验收样本：一条排行榜参考视频 → 复刻 → 验货 → 3 条变体 → 素材审核 → 出片 → 下载

**关键文件**：
- `clone-studio/server/src/services/recovery.ts`
- `clone-studio/server/src/static.ts`
- `clone-studio/README.md`
- `clone-studio/docs/e2e-report.md` — 验收样本的过程与证据

**验收标准**：
- Spec §9 完成定义全部勾选，e2e-report.md 附每步证据
- AC-002 真机通过（运行中删除、进程先停再删目录、后台任务不残留）

---

## 技术栈

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 运行时 | Node.js | 24.x（本机 24.11.1，Hypit 要求 ≥22.15） | 与 Hypit 同栈 |
| 包管理 | pnpm | 本项目用本机 11.6；`hypit-main` 按其声明的 10.33 | 两边各自安装，互不混用 |
| 语言 | TypeScript | 5.9.x | 与 Hypit 一致；npm 最新为 7.0，暂不追 |
| 后端 | Fastify + @fastify/multipart + @fastify/static | 5.12 / 10.1 / 10.1 | 轻、流式上传、静态托管 |
| 数据库 | better-sqlite3 | 13.0 | 单机单文件，同步 API 简化状态机 |
| 校验 | zod | 4.6 | Agent SDK 的 peer 依赖也是 zod 4 |
| Agent | @anthropic-ai/claude-agent-sdk | 0.3.277 | 自带 Claude Code 二进制；本机 CLI 2.1.277 |
| 后端执行 | tsx | 4.23 | 开发期直跑 TS |
| 前端 | React + Vite | 19.3 / 8.3 | |
| 路由 / 数据 | react-router / @tanstack/react-query | 8.4 / 5.103 | SSE 事件驱动 query 失效 |
| 样式 | Tailwind CSS + Radix 基元（shadcn 方式引入） | 4.3 | token 走 CSS 变量，单深色主题 |
| 渲染 | react-markdown + shiki | 10.1 / 4.4 | 抽屉与复刻文档 |
| 图标 | lucide-react | 最新 | 1.5px 线性 |
| 打包下载 | archiver | 8.0 | zip |
| 测试 | vitest | 5.0 | gate、guard、brief 解析、provider 生命周期 |
| 内核 | Hypit（`hypit-main/`，CLI 子进程） | 0.2.6 | 只读 |
| 生图（P1） | Codex CLI `$imagegen` | 0.153.4 | 订阅额度 |

## 数据库表

| 表名 | 所属 Phase | 用途 |
|------|-----------|------|
| `settings` | Phase 1 | 单例配置：路径、限额、熔断、并发 |
| `clients` | Phase 1 | 客户 |
| `templates` | Phase 1 | 模板、参考视频信息、工程目录、状态 |
| `batches` | Phase 1 | 批量提交、批次限额与已花 |
| `productions` | Phase 1 | 复刻片版本与变体，状态机 |
| `agent_jobs` | Phase 1 | Agent 会话、session id、花费、停止原因、档案快照 |
| `agent_messages` | Phase 1 | Agent 流式消息全量 |
| `builds` | Phase 1 | 每次出片的估价、实际、hypit build-id、错误 |
| `assets` | Phase 1 | 变体素材、来源 URL、是否用户替换 |
| `hypit_calls` | Phase 2 | 每次 hypit 调用的命令、退出码、JSON 输出 |
| `clone_verdicts` | Phase 6 | 每次复刻任务完成后宿主核完成判据的结果：缺的文件、`hypit check` 原样输出、未通过原文 |
| `pricing_rates` | Phase 6 | 费率表：能力（可限定 Endpoint）→ 计价单位 + 单价，设置页可编辑 |
| `estimates` | Phase 6 | 每次估价：plan / pricing 原样 JSON、明细、总价（空 = 拿不到）、闸门结论（auto / confirm / blocked）与原因、确认时刻 |
| `video_channels` | Phase 12 | 生视频通道配置（凭据存 secrets.json） |
| `model_profiles` | Phase 10 | Agent 模型档案（token 存 secrets.json，不入库） |

## 已知风险

- **本机渲染偶发失败（原「本机渲染不通」，2026-09-23 复测不再复现，不再阻塞 Phase 6）。** 2026-09-20 同一段时间里 `hyperframes.local`
  连出四次失败：三次 `Rendered visual frame rate differs from its document`（900 帧与完整片都有）、一次 `Page.captureScreenshot timed out`，
  另有一次 CLI 自身崩在 `Bad escaped character in JSON`。09-23 用同一份工作区、同一条命令、同样的软件（ffmpeg / 驱动 / hypit 0.2.6
  均未变）重跑，900 帧与 4112 帧都渲染成功，导出后 ffprobe 为 h264 1080×1920、30/1、帧数与文档一致。两次运行的渲染配置逐项相同，
  原先怀疑的 `[object Object]` 日志与 GBK 解码都已排除。更像当时机器负载（内存 / 显存）所致，但 09-20 没留下产物与读数，根因无法证实。
  对策：出片失败原文完整展示并可「重试出片」；渲染并发保持 1、别和生视频等重负载同时跑；失败时记下可用内存，下次出现就有数据。
  证据见 `clone-studio/docs/spike-notes.md`「本机渲染不通」及其「2026-09-23 复测」。
- **本机 `rmSync` 对中文名路径静默失败。** Phase 3 实测：`rmSync(dir, {recursive:true, force:true})` 删中文名目录时既不抛错也不删除，空目录和带文件的都一样，加 `maxRetries` 无效；同样的调用对 ASCII 名目录正常。（原先猜它与渲染失败同源于 ANSI 代码页，09-23 复测已排除渲染那边，两者无关。）**生产路径踩不到**：工程目录与 `.trash` 条目名都取自 UUID，用户输入的名称按设计从不进路径（`workspace.ts` 的 `slug` 只进 `package.json` 的 name 字段）。影响两点：一是涉及 fs 删除的测试不要用中文名造数据，否则测的是生产走不到的路径；二是判断删除成败要看 `existsSync` 结果，不能只看有没有抛异常，`purgeTrash()` 已按此实现。
- **本机内存/显存是共享资源。** 渲染 workers 默认 4 对这台机器偏高：Phase 0 实测 8 workers 触发 SQLite out of memory、2 workers 渲染进程 ACCESS_VIOLATION、1 worker 才稳。并发默认值要按实际余量定，不照搬默认；本机同时在跑生视频测试时不要启动渲染。
- ~~订阅登录下 SDK 花费字段与限流行为未知~~ **Phase 0 已解**：`total_cost_usd` 五组实跑均返回真实数值，$ 熔断成立且改用 SDK 原生 `maxBudgetUsd`。同轮发现 `canUseTool` 拦不住花钱动作，拦截机制已改（见 Phase 5）。
- ~~`hypit pricing` 对 TokenDance 的估价可用性未知~~ **Phase 0 已解且为否**：估价与实际花费都拿不到，改为自维护费率表并全部标"估"（见 Phase 6）。
- TokenDance 无 TTS，Seedance 拒绝真人脸参考 → 复刻系统提示里写明可用能力；缺能力时 plan 失败并指明。
- tsx 冷启动使每次 hypit 调用多数秒 → 证据流水线串行可接受；出片前的 check / plan / pricing 合并展示一次等待。
- 非 Claude 模型跑 hypit skill 成功率低 → Phase 10 只保证接得上与拦得住，不保证质量。

## 开发规则

- 每完成一个 Phase 执行四步走：Code Review → 测试完整性 → 编译验证 → 功能测试
- 四步走全部通过后才能 commit
- Commit message 用 feat、fix、refactor、chore 前缀
- 包管理器：pnpm
- 不修改 `hypit-main/`；UI 以设计稿为准，其次 Design-Brief
- 仓库就是项目根目录（分支 `feat/clone-studio`），`clone-studio/` 是其中一个子目录，**不要在它里面再 `git init`**。根 `.gitignore` 与 `clone-studio/.gitignore` 共同排除数据根目录、`secrets.json`、`app.db` 与构建产物
- 测试文件不进构建产物：`server/tsconfig.json` 的 `exclude` 含 `src/**/*.test.ts`，否则 `dist/` 里会多出一份 `*.test.js` 被 vitest 重复执行
