# Development Plan — Clone Studio

> 本文件记录项目的开发阶段划分、当前进度和剩余工作。
> 新 session 启动时应首先阅读此文件，了解项目状态后再继续开发。
>
> **当前进度（2026-09-26）**：Phase 0 ✅· Phase 1 ✅ · Phase 2 ✅（带两项遗留）· Phase 3 ✅ · **Phase 4 ✅**（五个 Task 交付，4.3 过六轮、4.4 / 4.5 各过四轮 review→fix；AC-004 / AC-005 / AC-006 真机浏览器实跑通过，用户实测确认）· **Phase 5 ✅**（五个 Task，review→fix 共 5.1 五轮 / 5.2 七轮 / 5.3 七轮 / 5.4 四轮 / 5.5 两轮；AC-007～010 真机通过，AC-002 自动化通过、真机转 Phase 13）· **Phase 6 ✅**（2026-09-24：五个 Task，review→fix 共 6.1 四轮 / 6.2 两轮 / 6.3 两轮 / 6.4 三轮 / 6.5 真机；一条真实参考视频导入 → 复刻 → 估价闸门两条路径 → 出片 mp4 经 ffprobe 核对，Agent 等价花费 $4.53）· **Phase 7 ✅**（2026-09-24：四个 Task，review→fix 共 7.1 三轮 / 7.2 三轮 / 7.3 三轮 / 7.4 真机；AC-011 同步误差实测最大 0.045s、AC-012、AC-013 真实打回一轮出 v2、AC-040 通过后 ④ 解锁，Agent 等价花费 $3.13）· **Phase 8 ✅**（2026-09-24：五个 Task，review→fix 共 8.1 四轮 / 8.2 两轮 / 8.3 三轮 / 8.4 五轮 / 8.5 真机；3 条 brief 用 Sonnet 真实写稿 → 只在素材审核处介入、替换一张图 → 3 条都出 mp4 经 ffprobe 核对，替换那条用了新图、Agent 花费没涨；AC-016 页面 21 行被拦、库里无新记录，Agent 等价花费 $3.36）· **Phase 9 ✅**（2026-09-25：五个 Task，review→fix 共 9.1 五轮 / 9.2 七轮 / 9.3 四轮 / 9.4 两轮 / 9.5 真机；AC-020 页内播放 + 下载 ffprobe、AC-021 三条打包解包文件名 = 成片名（重名加序号、非法字符替换）、AC-024 变体两笔花费与合计均标「估」、删除后文件真的没了、模板页头与客户页累计一致；出片接力卡顿根因是同步 taskkill 堵事件循环，修后长任务 0 段；Agent 等价花费 $2.15）· **Phase 10 ✅**（2026-09-25：五个 Task，review→fix 共 10.1 两轮 / 10.2 三轮 / 10.3 三轮 / 10.4 三轮 / 10.5 真机（顺带修了压缩调用漏计价，Spec v1.10.3）；AC-025 默认复刻记为订阅档案、AC-026 假端点收到注入的路径 / token / 模型且同时一条订阅任务照常跑、AC-027 复刻拦截看不见的档案不建任务、AC-028 错 key 401 原文标未验证、AC-029 单价熔断后继续用原档案 / 重跑改选别的档案、AC-030 删档案后历史不变；真实 Agent 会话 2 条，等价花费 $0.79）· **Phase 11 🟡**（2026-09-26：五个 Task，review→fix 共 11.1 两轮 / 11.2 三轮 / 11.3 两轮 / 11.4 十一轮 / 11.5 真机；AC-032（假 codex 正常退出不出图 → 出片失败带 JSONL 末段）、AC-033（未登录体检不过、开关打不开）真机通过；宿主成功路径用假 codex 走通（估价自动放行 $0 → 出图 1024×1536 → 3 秒成片 → 台账 $0、Codex 1 张）；**AC-031 与「试出一张图」被 Codex 订阅额度挡住**（额度 2026-09-27 08:09 恢复），真实 Codex 起了 3 次、出图 0 张，待补验；浏览器请求卡住定性为 bfcache 里的旧页占着 SSE、同主机 6 条连接占满；Agent 花费 $0）· 下一步：额度恢复后补验 AC-031 与「试出一张图」，再进 Phase 12。
> 分支 `feat/clone-studio`。「本机渲染不通」2026-09-23 复测两种失败都不再复现（900 帧与 4112 帧本地渲染均成功、ffprobe 核对通过），
> 不再阻塞 Phase 6，改记为偶发风险，见「已知风险」。
>
> 依据：Product-Spec.md v1.5、Design-Brief.md v1.0、设计稿 https://claude.ai/artifact/7DWGBWDbka6Wm71vV6TBbH（7 屏，UI 以设计稿为准）、Hypit-Research.md、用户提供的《Codex 生图配置说明》（不随仓库分发，要点已写入 Spec REQ-011）。
> 代码目录：`clone-studio/`（pnpm workspace：`server/`、`web/`、`providers/`）。`hypit-main/` 只读，不得修改。

## 总体架构

- `server/`：Fastify 后端，只绑 127.0.0.1。三类长任务都由它独占调度：确定性 hypit CLI 子进程、Claude Agent SDK 会话、出片 build。状态机只在后端写，前端只读 + 发动作。实时数据走 SSE。
- `web/`：React SPA，开发期 Vite 代理到后端，生产期由后端静态托管。
- `providers/codex-image/`：项目自有的 Hypit Provider 包，后端同步到 `<数据根>/node_modules/@clone-studio/codex-image`，hypit 从工作目录往上找到它（Phase 11 实测 `--package-root` 行不通，见 Phase 11「技术核实」）。
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
| 6.4 | 出片执行器与台账：出片前重生 Runtime Profile；`build --json` 提交拿 id + `status --watch --json --verbose` 跟到底 + `activity --watch --jsonl` 结构化进度（原计划的 `build --follow` 在 JSON 模式下到结束才给 id，取消没法告诉 hypit，第二轮审查后改）；判成败看 `result.outcome`；`get` 导出到 `output/`（`output` 进 `WORKSPACE_DIRS`）；key 只进 hypit 子进程；全局渲染并发默认 1、`hyperframes.local` workers 默认改 1（Spec 同步 + 存量迁移）；失败原文完整展示、「重试出片」、失败时记可用内存；台账（builds 估价 / build-id / receipt、Agent 花费）标「估」；出片进度 CMP-007；出片进行中拒绝换参考视频（6.1 只作废未出片的复刻片，渲染中的那条要这里保护）；复刻片出片完成后模板从 `cloning` 置 `awaiting_review`（6.1 判据通过时模板仍留在 `cloning`，没有别的 Task 管这次转换）；模板卡「成片数」只数变体与已验货的复刻片（`archive.ts` `templateStats` 现在数全部 done，复刻片出完会被提前计入，与 REQ-004「通过验货时作为第一条成片」冲突） | REQ-006 出片、REQ-009、AC-020（mp4 部分） | ✅ 三轮 review→fix，第三轮两阶段 PASS（首轮 2 HIGH：人取消后复刻片从 ② 页消失、估价 blocked 的复刻片没了估价卡；第二轮 1 HIGH：`status` 不带 `--verbose` 记不到 receipt，执行器改成提交拿 id + `status --watch`；第三轮 3 MEDIUM / 7 LOW 当场收，M2 转 Phase 7）。变异自检服务端 46 / web 20 全杀（独立拷贝）；审查员在 4412 / 5412 真起服务核过四条路由、复刻快照与三张卡的渲染；顺手把 `cli.test.ts` 进程树用例的固定睡眠改成轮询（整套并行跑时两次撞上） |
| 6.5 | Phase 6 真机验收与收口：一条真实参考视频导入 → 复刻完成 → 三个区块与估价卡；出片得 mp4 并 ffprobe；限额内自动出片与超限待确认各走一次；Phase 四步验证 | Phase 6 验收标准 | ✅ 2026-09-24 真机全部走通（隔离数据根 + 4413 / 5174 端口 + 真 Agent 订阅登录，见下「6.5 真机验收记录」）；顺手修了 activity watcher 在 Worker 未起时退出后不重起的问题（补测试与变异） |

**6.5 真机验收记录（2026-09-24）**：
- 环境：`CLONE_STUDIO_DATA_ROOT=C:\Users\wacin\AppData\Local\Temp\cs-acc6`（第一次用 scratchpad 下的长路径，tiles 步 `mkdtemp` 报 ENAMETOOLONG，见「已知风险」），后端 `tsx src/index.ts` 在 4413，vite 用独立配置在 5174（`root` 指向工作区源码、`cacheDir` 在 scratch，代理到 4413），真实服务 4310 / 5173 未动；WhisperX 复用本机 8765 上已在跑的那个。
- 参考视频：`clone video/pt4DcHaEU5HQUi4N.MP4`（720×1280、30fps、13.978s、1.77 MB）。导入 09:20:33 起，fetch / probe / transcribe / tiles 09:20:51 全部 done，复刻任务随即自动起（01:20:49Z），**不是补跑**（模板是这次新建的）。
- 复刻会话：Opus（默认档案，订阅登录、未设 API key），01:33:51Z 完成，用时 13 分钟，等价花费 **$4.53（估）**，$5 熔断未触发但已接近——14 秒的片子就用掉 $4.5，长片要么提高 `agent_budget_usd`，要么提示词再省（Phase 7 注意）。文件出现顺序：`reference.svrun` 09:30:46 → `ANALYSIS.md` 09:32:55 → `TIMELINE.md` 09:33:39，② 页三个折叠区块随之逐个出现（分析摘要 / 时间线（时间码可点）/ 校验结果「hypit check 通过 · reference.svrun · 1 个目标」）。宿主判据通过：`{ok:true, targets:["final.video"]}`，复刻片 v1 排队。
- 超限待确认（两次）：① 先给 `render-visual` 设按秒 $0.5 的费率——真实 plan 里本地渲染的 `needs[].summary.fields` 是空的（帧范围要到 build 时才定），按秒时长拿不到 → 结论「估价拿不到，按超限处理」，卡片给「确认出片（估价拿不到）」+「重新估价」，符合 Spec REQ-006「拿不到时长也按估价拿不到」；② 改成按次 $2 再估 → `totalUsd 2, decision confirm, reasons over_item_limit`，估价卡靠 SSE 自己刷新成「$2.00 · 待确认 · 超过单条限额 · 确认出片 $2.00」，单条限额进度条超出。
- 限额内自动出片：删掉费率、重估 → `$0, auto` → 执行器自动起片。09:36:30 提交，09:36:41 台账已有 `bld_20260924T013632683Z_F8D042CAC5`，进度行 `0/5 steps` → `preparing resources` → `rendering frames 21/418…` → `encoding video`，09:38:08 done（1 分 38 秒）。导出 `output/replica-v1-1d837e8d.mp4`（2,848,848 字节）；**ffprobe**：h264 720×1280、`avg_frame_rate=30/1`、`nb_read_frames=418`、13.933s，aac 13.933s——与文档一致（`reference.svml` 720×1280，ANALYSIS「画面 418 帧（13.933s）」）。模板转 `awaiting_review`，复刻快照 `replica.status=done` 带 `buildId`，出片卡显示文件名、`$0.00 估`、hypit build id；本地渲染无 receipt。
- 真机抓到并当场修的：第一次出片 `activity` 全程为 null——watcher 在提交前就起了，那时 Runtime Worker 还没起来，`hypit activity` 直接退出，没人重起。改成进程退出后 2 秒重起（只要该目录还在被看），补用例「watcher 重起」与变异「not respawned」；`hypit runtime down` 停掉 Worker 后重启后端再起一条（v3），activity 从第一帧就有（`requests 5/0` → `preparing resources` → `rendering frames · 6/418 frames` → `encoding video`）。注意 activity 的阶段名里带进度（`rendering frames · 7/418 frames`），前端 `activityLabel` 按前缀匹配。另修出片卡「花费」标签在窄栏被拆成两行（`shrink-0`）；`cli.test.ts` 进程树用例整套并行跑时约一半概率红：改名探测正好撞上孙进程 spawn 的瞬间（cwd 被改走 → ENOENT），改成看孙进程写的 started 标记再探测，连跑三遍全绿。
- 取消 / 重试 / 删除前取消 / 重启孤儿：真机只验了「提交后 10 秒内 id 落台账」这一前提，取消与孤儿路径靠 6.4 的单测与变异（46 条全杀）。`hypit cancel` 对本地 Worker 不需要凭据（手动 `hypit cancel` 一条正在渲染的 build 即停）；TokenDance 侧待 Phase 7 有 key 时核。
- 花费合计：Agent $4.53（估）+ 出片 $0（本地）；未调用任何付费生成服务。验收后临时数据根已删、后端与 vite 已按 PID 停掉。

**给 Phase 7 的交接（Phase 6）**：
- ③ 验货读 `builds.output_path`（`GET /api/productions/:id/build`），复刻片出完模板已是 `awaiting_review`；通过验货时把模板置 `approved`——`templateStats` 的成片数才会把复刻片算进去。
- 「重试出片」不重过闸门（6.4 第三轮 M2，见上）；批次「已花」按估价算一次。
- 按秒计价的本地渲染在 plan 阶段拿不到时长（needs 字段为空）；付费 Provider（Seedance 等）的 needs 带 duration，按秒才算得出。变体的估价卡可以考虑用参考视频时长兜底，但那是估「本地」，本来就 $0。
- Agent 预算：14 秒片子的复刻一轮 $4.5，默认 $5 对长片不够；变体会话更短（改词不改结构），但要盯。
- activity 帧的 `requests {total, completed}` 已进 `BuildView.activity`，④ 变体的「生成素材 n/m」直接用。
- 删除模板会先取消正在跑的出片（含 hypit 侧）；后端重启会取消上次留在 Worker 上的 build。

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
- `clone-studio/server/src/services/build-run.ts` — 出片执行器的队列一侧（6.4）：放行队列（auto / 已确认）按 `settings.render_concurrency`（默认 1）推进；起片、取消、重试、删除前取消（`cancelRunningBuilds`，deletion.ts 调）。
  `build-execute.ts` — 一次出片的三步，都是 hypit 子进程、key 只进它们的环境：① `build <run> --runtime … --workspace … --json` 提交，**立刻拿到 build id 落台账**（`--follow` 在 JSON 模式下到结束才给 id，而 hypit 自己说 Ctrl-C 只是不看了、Build 照跑，所以不用 follow）；
  ② `status <id> --workspace … --watch --json --verbose` 跟到结束（stderr 进度行解析在 `build-progress.ts`，成败只看最终 JSON 的 `result.outcome`，`work.state: done` 的失败 build 也能判失败）；③ 成功 `get` 导出到 `output/<kind>-v<version>-<buildId 前 8 位>.mp4`（重出不覆盖上一版；composite 导出取 `files/` 下的 mp4）。
  出片前重写 Runtime Profile；失败原文整段落 `builds.error_message`、`context_json` 记当时可用内存与最后一条进度；跟进度的进程超时或炸了先 `hypit cancel` 再记失败，别让 Worker 继续花钱。
  `status` 要带 `--verbose`：hypit 的 `buildStatusView` 不带它会把完成了的操作连 receipt 一起过滤掉（cli/test/view.test.ts「retains completed receipts only when requested」），台账就永远记不到 receipt（6.4 第二轮审查 HIGH）；多条 receipt 记第一条带 url 的。
  提交那一步不接取消信号：半路杀掉拿不到 id、Worker 上的 build 成孤儿，等它返回再 `hypit cancel`；提交超时 / 炸了时 activity 帧里唯一活跃的 build 当作它取消。重启：`markStaleRunningAsInterrupted` 报出上次还在跑且已提交的 build，`index.ts` 起来后逐条 `hypit cancel`（`cancelOrphanedBuilds`）再 pump。
  `pumpBuilds` 只数真起来的（校验在同步的 `beginBuild` 里做，起不来记日志不占名额）；`updateBuild` 的列名对白名单。
  第三轮审查（两阶段 PASS）后当场收的：猜孤儿时排除同目录里别的 build 的已知 id（渲染并发 > 1 时才会碰到）；`status` 以「需要处理」退出时 attention 的原文当失败原因并让 hypit 取消；迁移 v7 补测试；`hypit cancel` 也带凭据环境（是否必需 6.5 真机核）。
  **Phase 7 交接（第三轮审查 M2）**：「重试出片」沿用上一次的估价与确认，不重过闸门——本机渲染 $0 无所谓，接上付费 Provider / 批次后会绕过批次限额（AC-019 的「已花」只按估价算一次）。Phase 7 定：重试前重估并按批次已花重新判，或把重试计入已花。
  取消 = AbortController 中止本地子进程树 + `hypit cancel <id>`（提交一完成就有 id）；**人取消出片的那条 build 记 `cancelled`，出片单位回到 `failed`**（出片单位上的「已取消」只表示作废——`latestReplica` 不认它，② 页会看不见），② 页照样给「重试出片」。
  「重试出片」= 出过片的 failed / interrupted 回排队再 pump（估价结论还在，不重估）；没出过片的 failed 是估价 blocked，拒绝重试、走「重新估价」。复刻片出完模板 `cloning → awaiting_review`。
  `build-store.ts` — 台账读写与对外形状（路由、删除、复刻快照都只依赖它，不把执行器拉进依赖图）。
  `build-activity.ts` — 每个工作目录（= 一个 Runtime）一个 `activity --watch --jsonl` watcher，有 build 在跑就开着；帧按 hypit build id 对自己那条，渲染并发 > 1 时不同模板互不串。
  `routes/build.ts` — `GET /api/productions/:id/build`（没出过 404 NO_BUILD）、`POST` 同路径手动起片（不在排队 NOT_QUEUED、没过闸门 NOT_RELEASED）、`/cancel`（NOT_RUNNING）、`/retry`（NOT_RETRYABLE）。
  `GET /api/templates/:id/clone` 的 `replica` 带 `buildId`（最新一次 build，没出过片是 null）：② 页据此分「估价没过的失败」（估价卡，可重估）与「出片失败 / 取消」（出片卡，可重试）——6.4 首轮审查两条 HIGH 的修法。
  key 只进 hypit 子进程：`credentialEnv()` 只作为 runHypit 的 env 传下去，测试断言宿主 `process.env` 里没有。台账不另建 ledger.ts：花费 = `builds.estimate_usd`（一律标「估」，receipt 只有 id / url 没有金额）+ AgentJob 花费，`archive.ts` `templateStats` 合计；
  ④ 变体（Phase 7）复用同一执行器，`releasedQueued` / `pumpBuilds` 不看 kind。重启：`markStaleRunningAsInterrupted` 把跑到一半的 build 记 failed、出片单位记 interrupted（可重试），`index.ts` 起来后 `pumpBuilds()` 接上放行了没起的。
  6.1 留下的两条在这里收：失败的复刻片（估价 blocked / 出片失败）判据再次通过时作废它、建下一版（不复用，复用会永远停在 failed）；核对开始时记模板 `updated_at`，核完比对，换参考视频又回到复刻中而新一轮没起来的旧结论不建复刻片。
  `POST /api/templates/:id/clone` 在模板已到待审 / 已通过时也是 `CLONE_EXISTS`（不是「还没到复刻这一步」）。
  设计偏离：CMP-007 的「生成素材 n/m」在复刻片上只在 activity 帧带请求计数、或进度行只有步数时出现，本机渲染直接是 提交 / 准备 / 渲染 / 编码 / 保存；模板卡「成片数」只数变体与已验货的复刻片（REQ-004：验货通过才是第一条成片）。
  前端 `web/src/components/clone/BuildCard.tsx`（CMP-007：阶段 + 细进度条 + 用时 + 取消二次确认；失败卡：code + failure 原文 `<pre>` + 可用内存 + 重试出片；完成卡：文件名、估价标「估」、hypit build id、receipt 链接）、`web/src/lib/build.ts`；`build` 事件也走抽屉那条 SSE。
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

**Task 拆分（2026-09-24）**，按序做，每个走 review→fix 循环，两阶段 PASS 后单独 commit：

| Task | 内容 | 覆盖 | 状态 |
|---|---|---|---|
| 7.1 | 并排同步播放器 CMP-004（web）：两路 `<video>` 共享进度条与控制、播放/暂停/拖动/倍速一致、逐帧前后键、声音来源切换默认原片、任一路缓冲两路同停、9:16 按高适配。由云端会话在分支 `feat/phase7-sync-players` 实现，本地拉下来审查、改到两阶段 PASS 再合进 `feat/clone-studio`；分支不可用就本地自己写 | AC-011、REQ-004 播放器 MUST | ✅ 云端会话起草（分支 `feat/phase7-sync-players` @ 1215f5c），本地三轮 review→fix，第三轮两阶段 PASS（首轮 2 HIGH：stalled 后只认 canplay 会卡死、两片时长不同时短的播完后拖回去冻住；第二轮 2 MEDIUM：一路坏了连累另一路、暂停时登记的缓冲解不开；第三轮 1 MEDIUM 当场修：一路坏了另一路播到尾后点播放没反应）。变异自检 32 条全杀（独立拷贝） |
| 7.2 | 验货后端（server）：`GET /api/templates/:id/review`（历次复刻片版本 + 每版出片结果、哪版可通过）；`GET /api/productions/:id/video`（复刻片 mp4，与参考视频共用一套 range / 数据根内读取）；`POST .../approve`（只准通过最新一版已出片的复刻片，模板置 `approved`、记下是哪一版，成片数只算这一版）；`POST .../rework`（意见 1-2000 字，`host_prompt` 分出 `rework` kind，resume 原会话，模板回到 `cloning`，之后照 6.x 的判据 → 估价 → 出片出下一版）；重试出片重过闸门（6.4 第三轮 M2：重试前重估，这条出片单位之前提交过的 build 估价计入它自己的「已花」）。Spec 同步 | REQ-004、REQ-006、AC-013 后端、AC-040 后端 | ✅ 三轮 review→fix，第三轮两阶段 PASS（首轮 1 HIGH：重试闸门同一毫秒会复用旧放行；第二轮 2 MEDIUM：排队中的打回意见被中止 / 重启后丢失、「打回被取消」分支走不到已删；第三轮只剩 LOW，L-1 当场收）。变异自检 32 条全杀（独立拷贝） |
| 7.3 | ③ 验货页（web）SCREEN-005：左原片右复刻片 vN（CMP-004）、版本分段控件、时长差与分辨率差（取播放器元数据）、底部固定操作区「打回」（次按钮，展开意见框，1-2000 字计数）与「通过验货」（主按钮，只对最新一版可用）；渲染中 / 出片失败沿用 CMP-007 出片卡；通过后跳到 ④；抽屉按 `rework` 画「打回意见 #n」分隔；未通过时 ④ / ⑤ 的锁定说明「先通过验货」 | SCREEN-005、AC-011/012/013/040、Design-Brief §A.1 | ✅ 三轮 review→fix，第三轮两阶段 PASS（首轮 1 HIGH：通过后布局拿旧模板状态把人从 ④ 送回 ③，外加 4 MEDIUM：换版本拿上一版元数据算差、渲染中 / 失败态落点、锁定的 ④ 点了没反应、操作区不贴底；第二轮 1 MEDIUM：通过 / 打回被拒的路径没测试；第三轮只剩 LOW，三条当场收）。变异自检 18 + 7 条全杀（独立拷贝）。第三轮顺带查出 Phase 6 的服务端缺陷 S-M1（中断的复刻片活到下一轮，③ 成死路），已在 7.4 修 |
| 7.4 | Phase 7 真机验收与收口：14 秒参考视频在隔离环境走到复刻片已出 → 并排播放拖动同步取 currentTime 证据 → 打回一次（真实会话）→ v2 出片、v1/v2 可切换播放 → 通过验货后 ④ 解锁；Phase 四步验证 | Phase 7 验收标准 | ✅ 真机通过（证据见下方「Phase 7 收口」）；第三轮审查查出的 S-M1 在这里修（中断的复刻片新一轮作废），修复一轮 review 两阶段 PASS，审查员在独立拷贝里另走了「重启 → 换参考视频 → 新一轮」的真实路径，修前失败、修后通过 |

**关键文件**：
- `clone-studio/server/src/services/review.ts` — 验货（7.2）：`reviewState`（这一轮的版本 = 当前复刻任务 `created_at` 之后、未作废的复刻片；
  每版带最新 build 与播放地址；`approvable` = 模板等验货且最新一版已出片；`reworkable` 再加上复刻任务完成且会话还在；`nextRound` = 已打回次数 + 2）、
  `approveReplica`（只准最新一版已出片的；`templates.approved_replica_id` 记下是哪一版，迁移 v8 给存量已验货模板补上；`templateStats` 成片数只算这一版）、
  `reworkReplica`（意见去首尾空白 1-2000 字 → `rejectPrompt(意见, 轮次)` → `scheduler.rework` resume 原会话、运行类型 `rework` → 模板回到 `cloning`；
  之后 6.1 的核判据、6.3 的估价闸门、6.4 的执行器原样接手，`ensureReplica` 看到最新一版已出片就建下一版）。
  状态变了往 `global` 推 `archive`、往 `template:<id>` 推 `review` 事件。
- `clone-studio/server/src/routes/review.ts` — `GET /api/templates/:id/review`、`POST .../approve`（`NOT_REVIEWING` / `NOT_LATEST` / `AGENT_ACTIVE`）、
  `POST .../rework`（`INVALID_NOTE` / `NOT_REVIEWING` / `NOT_REWORKABLE`；会话没了 / 任务被取代在 service 里先判成 `NOT_REWORKABLE`，调度器的 `NO_SESSION` / `SUPERSEDED` 是兜底）、`GET /api/productions/:id/video`（最新一次 build 出完的 mp4，`NO_OUTPUT`）。
  `routes/video-file.ts` — 参考视频与复刻片共用的 range 发送（数据根内真实路径校验、按魔数回类型），从 `media.ts` 抽出来。
- `agent/scheduler.ts` `rework()` + `job-guards.ts` `assertReworkable`（只接已完成、有会话的最新任务）；`RunKind` 加 `rework`，`Pending.kind` 明说运行类型。
- 打回意见落库（7.2 第二轮审查 S2-M1）：`reworkReplica` 排队后记一条 `host_rework_pending`（抽屉不画）；`review.ts` `pendingRework` 看它有没有以同文的 rework 提示交出去过，
  没交出去（排队中被中止、开跑前重启）时 `POST /api/agent-jobs/:id/continue` 用它、运行类型仍是 `rework`（`scheduler.continueJob` 第三参数）。
  第一轮加过「打回被取消回到等验货」，第二轮审查指出界面与删除只会「中止」（→ 中断）、取消走不到，已删掉；中断的打回照 REQ-003 继续。
- 重试出片重过闸门（6.4 第三轮 M2，7.2 定下）：`build-run.ts` `released()` 要求估价**严格**晚于这条的上一次 build（同一毫秒也不行，7.2 审查 S2-H1），
  重启补估 `unestimatedQueued` 也收「最新估价不晚于上一次 build」的排队项（S2-M1），`retryBuild` 放回排队后调 `estimateProduction`；
  `estimate-run.ts` 批次「已花」加上批次里已提交却失败 / 取消的 build 估价。复刻片没有批次，重试只是重估（超单条限额就停在待确认）。
- `clone-studio/web/src/components/SyncPlayers.tsx` + `useSyncPlayback.ts`（7.1）— CMP-004：左路是主时钟（左路到尾或读不出来时换右路），另一路漂移 >0.2s 拉回；
  到尾按「时间到了时长」判（浏览器 `ended` 拖回去之前一直是真），拖回去后 intent 是播放就把没到尾的都播起来；缓冲只认 `readyState < 3` 且打算播时的 waiting / stalled，
  canplay / canplaythrough / playing 任一解除，点播放时先清掉其实已够数据的；一路读不出来就地红字、另一路照常；换片加载出元数据后对齐进度、补倍速静音、接着播；
  `fps` 给逐帧与进度条步长（③ 页传参考视频探测到的帧率）；`onMeta` 回报时长与分辨率。测试替身在 `web/src/test/setup.ts` + `media.ts`（readyState / ended / error / 被拒的 play）。
  由云端会话在 `feat/phase7-sync-players` 起草，本地审查三轮改完再合进来（分支保留在远端，不合并）。
- `clone-studio/web/src/pages/steps/ReviewStep.tsx` + `ReworkPanel.tsx`（7.3）— SCREEN-005：版本分段控件（这一轮 v1 / v2…，默认最新）、SyncPlayers、两片差异一行（`lib/review.ts` `describeDiff`）、
  选中的版本没出好换成 CMP-007 出片卡；底部 sticky 操作区左「打回」（展开意见框，标题「打回意见 #n」，按去首尾空白计 1-2000 字）、右「通过验货」（只对最新一版可用，禁用写明原因）；
  通过后跳 ④、打回后跳 ② 并把新任务交给抽屉；`review` / `build` / `clone` 事件都让它重拉。抽屉按 `rework` 画「打回意见 #n」分隔（`lib/agent-timeline.ts`，第一次复刻是第 1 轮）。
  步骤条锁定原因（`lib/steps.ts` `lockedReason`）：锁住的步骤用 `aria-disabled` 而不是 `disabled`，点了由布局弹提示「「变体」还没解锁：先通过验货」（AC-012；disabled 按钮不派发点击、title 气泡不可靠，Phase 3 记过）。
  **设计偏离（7.3 审查 MEDIUM-2 定下）**：SCREEN-005 的「加载 = 渲染中右路显示 CMP-007」「错误 = 出片失败卡」落在 ② 复刻页——模板要到复刻片出好才进「等验货」，③ 在那之前是锁着的；
  ③ 里只在选中的那一版没片时兜底显示出片卡。通过后先把缓存里的模板状态写成 approved 再跳 ④（7.3 审查 HIGH-1：不写的话布局按旧状态把人送回 ③），整页回归用例 `ReviewStep.flow.test.tsx` 故意让模板详情晚回来 60 毫秒。
  失败文案带动作前缀「通过验货没成功：」「打回没提交：」，后发生的那个在前；失败路径用例在 `ReviewStep.errors.test.tsx`，共用桩在 `web/src/test/review-kit.tsx`。
- `server/src/services/replicas.ts` `cancelOpenReplicas`（7.4 修 S-M1）：开新一轮（`startClone`、换参考视频）时连 `interrupted` 的复刻片一起作废。
  不然重启打断出片后那条会被 `ensureReplica` 复用、新一轮不建版本，③ 只认这一轮建的版本就成了死路。回归用例在 `clone-start.test.ts`。

**验收标准**：
- AC-011、AC-012、AC-013 通过

**Phase 7 收口（2026-09-24）**：
- 真机验收在隔离环境跑：数据根 `%TEMP%\cs-acc7`，后端 4413，vite 5174（scratch 里的 vite 配置），用 Phase 6 那条 14 秒参考视频。
  浏览器取证改用独立的无头 Chrome（临时配置目录，DevTools 协议）：Chrome 扩展的标签页在后台时 `visibilityState` 是 hidden，`<video>` 一直停在 readyState 0，截图也超时。
- AC-011：拖动与点击进度条 8 个点，暂停时两路 `currentTime` 完全一致；播放中采样与播放中拖动后误差 0.023–0.045s，全部 ≤0.2s。
- AC-012：通过前 ④ 是 `aria-disabled`、title「先通过验货」，点了弹「「变体」还没解锁：先通过验货」，页面停在 ③。
- AC-013：打回一轮，意见是「结尾最后 1 秒淡出到黑场，画面和声音一起」，会话 resume，抽屉出现「打回意见 #2」分隔线。v2 出片后 ffprobe 核对 720×1280、30fps、13.93s。
  v2 结尾亮度从 116 降到约 20，v1 不变，说明意见真的落进了稿子。③ 默认显示 v2，切到 v1 能播，此时「通过验货」禁用并写明「只能通过最新一版 v2」。
- AC-040：通过 v2 后跳到 ④，④ 与 ⑤ 都可进。服务端记下 `approved_replica_id` = v2，模板成片数是 1。
- 操作区贴底（7.3 审查 MEDIUM-4）：1440×900 的无头截图里底栏贴着工作区底边，两路播放器等高。
- 花费（订阅等价，全部标「估」）：
  | 会话 | 模型 | 花费 |
  |---|---|---|
  | 首次复刻两次失败 | Haiku | $0.62 |
  | 首次复刻 | Sonnet | $1.17 |
  | 打回那一轮 | Sonnet | $1.34 |
  出片两次都是本机渲染，$0。目标原定只有打回那一轮用真实会话，其余用 Haiku；实际上 Haiku 写不出合法的 svml，首次复刻只好换 Sonnet，偏离如实记在这里。
- 编译与测试：仓库根 `pnpm run check` 的四步用 node 直跑，没有走 pnpm。prettier 与 eslint 0 错误，两个包 tsc 0；server 测试 646 通过、4 跳过；web 测试 344 通过。
  没走 pnpm 是因为 `node_modules/.modules.yaml` 缺失，pnpm 会先自动重装，而 better-sqlite3 被用户在跑的后端锁着，重装会 EPERM。
- 收尾：验收用的后端、vite、无头 Chrome 按记下的 PID 停掉，`hypit runtime down` 与 `programs down` 都跑了，临时数据根已删。

**给 Phase 8 的交接（Phase 7）**：
- ④ 变体只对 `approved` 模板开放，基准是 `templates.approved_replica_id` 那一版复刻片的稿子。变体出片复用 6.4 的执行器，重试会重过闸门，批次「已花」计入失败 / 取消的 build 估价（7.2）。
- 复刻至少要 Sonnet：Haiku 两次都编出不存在的 svml 导入。Phase 10 的模型档案要把这一点写进默认值与提示。
- 7.3 留下的 LOW：「已通过验货 · vN」徽标只用单版本测过；禁用原因文案与 `aria-pressed` 没有断言。
- 跑 `pnpm run check` 之前，先停掉 4310 与 5173 的开发服务，再 `pnpm install` 修好 `node_modules`，之后才能直接用 pnpm。

---

## Phase 8: 批量变体与素材审核（REQ-005，设计稿"④ 变体队列""④ 素材审核"） ✅

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

**Task 拆分（2026-09-24）**，按序做，每个走 review→fix 循环，两阶段 PASS 后单独 commit：

| Task | 内容 | 覆盖 | 状态 |
|---|---|---|---|
| 8.1 | 变体编排后端（server）：brief 解析校验（空行忽略、每行 5-500 字、1-20 条，超 20 整批拒绝不建任何记录）；`POST /api/templates/:id/batches`（只对已验货模板，批次记录 + 目标语言 / 备注 / 模型 / 批次限额，每条建 variant 出片单位、复制模板源文件到 `productions/<id>/`、入队变体 Agent 任务，并发沿用调度器上限 2）；变体任务的工作目录 = `productions/<id>/`（Agent 只能写这里，hypit 按最近的 `package.json` 认模板目录为项目根）；变体提示（改台词 / 条目 / 提示词、联网找图统一裁切、`SOURCES.json` 记来源与缺口、`SCRIPT.md` 台词全文、写到 `variant.svrun` check 通过）；任务状态 ↔ 出片单位状态同步（排队 / Agent 写稿 / 等待额度 / 熔断 / 中断 / 失败 / 已取消），完成后宿主核判据（`variant.svrun` check 通过、`SOURCES.json` 能解析、`SCRIPT.md` 存在）→ 解析素材入 `assets` → 素材待审，不过则改判失败；重启时对齐状态；取消变体；模板的继续 / 重跑 / 打回把该模板下未结束的变体任务算进「未结束任务」；`GET /api/templates/:id/variants`（按批次分组、批次已花 / 限额）与 `GET /api/variants/:id`（单条，素材审核面板的页头用）；`GET /api/agent-models`（过渡用的模型清单，Phase 10 换成档案）。Spec 同步 | REQ-005、FLOW-003 步骤 1-3、AC-014、AC-016 后端 | ✅ 四轮 review→fix，第四轮两阶段 PASS（首轮 1 HIGH：已取消的变体能被重跑 / 继续救活、抽屉里中止会作废变体，外加 3 MEDIUM：取消与批次已花的 Spec 措辞、默认名称、变体会话能改模板的 Runtime Profile；第二轮 1 HIGH：重跑清理顺着 assets junction 删到目录外；第三轮 1 HIGH：重跑复制原稿顺着硬链接写到目录外；第四轮只剩 LOW，L3 当场收）。变异自检 41 条：杀 37、等价 4（独立拷贝） |
| 8.2 | 素材审核与出片后端（server）：`GET /api/variants/:id/review`（素材、台词全文、估价、批次，哪些动作能做与原因）；`GET /api/assets/:id/file` 素材图片（变体目录内）；替换单张（jpg / png / webp ≤20 MB，ffprobe 读原图尺寸、ffmpeg 缩放裁切回原尺寸、写回原文件名，标「已替换」、清缺口，不起 Agent）；「素材通过」（有缺口拒绝；写入运行文件路径、回排队，交给 6.3 的估价闸门与 6.4 的执行器，批次限额停靠沿用）；打回（resume 该变体会话，意见 1-2000 字）；重跑（只删 Agent 抓来的素材与稿子，保留用户替换的图并告诉新会话）；出片完成 / 失败 / 重试出片沿用执行器 | REQ-005、REQ-006、FLOW-003 步骤 4-6 与分支、AC-015、AC-017/018/019 | ✅ 两轮 review→fix，第二轮两阶段 PASS（首轮 5 MEDIUM：重跑与进行中的估价 / 重试出片会把变体卡死、早期出错不删上传文件、素材通过后的估价出错被吞、打回时没告诉会话哪些图是人换的；第二轮只剩 LOW，三条当场收）。变异自检 23 条：杀 22、等价 1（独立拷贝） |
| 8.3 | ④ 变体页（web）SCREEN-006：提交区（等宽行号文本框、实时「N 条」、红字校验不提交、空状态三条示例点击填入、目标语言、批次备注、Agent 模型下拉、批次限额与已花 CMP-006 迷你版、「提交 N 条变体」）；按批次分组的队列（CMP-002 行、CMP-003 状态、模型、Agent 耗时、估价 / 花费、行尾动作）；需处理的行置顶带左侧竖线；五个筛选；批次限额用尽的组头琥珀提示；失败行就地展开错误原文、重试出片 / 重跑；取消走二次确认；未验货整页锁定 | SCREEN-006、AC-014/016 前端 | ✅ 三轮 review→fix，第三轮两阶段 PASS（首轮 1 HIGH：交给出片之后停下的变体给了注定被拒的「继续」、渲染被打断的没给「重试出片」，外加 4 MEDIUM：错误原文不说哪一步、前端条数上限没封顶 20、不可选模型的原因看不见、输入框没有焦点环；第二轮 4 MEDIUM：重试后估价没过时显示旧的出片错误、批量结束 toast、列头、TaskRow 竖线让客户页错位；第三轮只剩测试盲区与 LOW，当场补）。变异自检 40 条全杀（独立拷贝）；真浏览器外观在 8.5 核 |
| 8.4 | 素材审核全幅面板（web）SCREEN-007：左 65% 素材网格 CMP-005（缩略图、条目名、来源域名链接、悬停出替换 / 看大图、无来源黄角标、已替换强调色角标、缺口红虚线 + 上传）；右 35% 台词全文 + 估价卡 CMP-006 + 动作区（素材通过、有缺口禁用并写明原因；打回写意见；取消）；超限后动作区变「确认出片 $x.xx」；出片进度 CMP-007；底部版权提示 | SCREEN-007、CMP-005/006/007、AC-015/018 前端 | ✅ 5 轮审查（第 5 轮 Stage 1 / Stage 2 PASS）；变异 web 32 个 + server 2 个全杀；真机看 8.5 |
| 8.5 | Phase 8 真机验收与收口：隔离环境准备已验货模板 → 提交 3 条 brief → 只在素材审核处人工介入（至少替换一张图）→ 至少 2 条出 mp4 并 ffprobe 核对 → 替换的那条用了新图且 Agent 花费没增加；AC-016 页面提交 21 行；AC-014 / AC-018 / AC-019 用假 runner 与自动化测试取证；四步验证 | Phase 8 验收标准 | ✅ 真机（2026-09-24，见下「Phase 8 收口」） |

**关键文件**（原计划的文件名按实际落地改写）：
- `clone-studio/server/src/services/briefs.ts` — brief 解析校验（空行忽略、每行 5-500 字按码点、1-20 条，上限取设置与 20 的较小值）、默认名称取前 20 字（REQ-007）。
- `clone-studio/server/src/services/variants.ts` + `routes/variants.ts`（8.1）— 批量提交（只对已验货模板；先复制模板原稿再落库，落库失败清目录；同批变体 created_at 逐条错开 1 毫秒，批次闸门靠它分先后）、
  队列（`GET /api/templates/:id/variants` 按批次分组、批次已花 / 限额与闸门同一算法 `batch-budget.ts`）、单条、取消（先作废再停任务与出片：只从未结束的状态改，停任务的状态同步不再闪「中断」）。
  `GET /api/agent-models` 是 REQ-010 档案落地前的过渡清单（`agent/agent-models.ts`，Haiku 列出但不可选）。
- `clone-studio/server/src/services/variant-flow.ts`（8.1）— 任务状态 → 变体状态（排队 / 写稿 / 等额度 / 熔断 / 中断 / 失败；任务「已取消」记中断，变体的已取消只由 ④ 的取消设），
  只管还没交给出片流水线（run_path 为空）的；完成后宿主核判据（`variant.svrun` check 在变体目录里跑、`--workspace` 指模板目录；`SOURCES.json` 能解析、列的图都在 `assets/` 下且是普通文件；`SCRIPT.md` 存在），
  过了按清单建素材行进素材待审，不过就把任务改判失败（原因前缀「变体未达完成判据」，「继续」时交给会话）；核的过程中被取消 / 交出的不改判。重启时按最新任务对齐一遍。
- `clone-studio/server/src/services/variant-files.ts`（8.1）— 变体目录 = `<模板目录>/productions/<id>/`（hypit 按最近的 package.json 认模板目录为项目根，源文件相对引用按声明它的文件解析）；
  `SOURCES.json` 解析（路径规范化、Windows 下查重不分大小写、来源只认 http / https）；重跑清理 `resetVariantProducts`：先验真实路径在数据根 `clients` 下且父目录叫 productions，逐项 lstat、链接只拆不进，
  原稿删了重拷、写前先删目录项（不顺着硬链接写出去，8.1 第二、三轮审查 HIGH），留下用户替换过的图并写 `USER_ASSETS.json` 交给新会话。
- `clone-studio/server/src/agent/job-guards.ts` — 模板的继续 / 重跑 / 打回要等该模板下的变体任务结束（Task 5.2 复审 S2-L7）；已作废、已交给出片的变体不能再起 Agent 任务。
  `agent/guard.ts` 同时保护项目根的 Runtime Profile（变体会话在子目录里，生效的是模板那份）；`agent/prompts.ts` 找可用能力时往上找到项目根为止。
- `clone-studio/server/src/services/batch-budget.ts` — 批次已花 / 限额（从 estimate-run.ts 拆出守 300 行）。
- `clone-studio/web/src/pages/steps/VariantsStep.tsx` + `components/variants/{SubmitPanel,BriefEditor,BatchBudgetBar,VariantQueue,VariantRow}.tsx` + `lib/variants.ts`（8.3）— SCREEN-006：
  提交区（等宽行号、实时条数、逐行红字与整批上限，规则与服务端 briefs.ts 一致、上限取设置与 20 的较小值；空状态三条示例；目标语言、批次备注、模型下拉——不可选的把原因写进选项文字；批次限额与迷你 CMP-006）；
  队列按批次分组（新的在前）、组头花费条与「批次限额已用尽，剩余变体等你确认」、列头（状态 112 / 模型 128 / 用时 56 / 估价 64 / 花费 72 / 动作 232 定宽对齐）、要人动手的组内置顶带 2px 竖线（`TaskRow` 的 `accent`，
  不传就不画、客户页不受影响）、五个筛选。行尾动作对着服务端规则：「重试出片」= 失败 / 中断且最近一次出片失败或被取消；「继续」= Agent 那一段停下、还没交给出片、任务本身还能 resume（`nextActions`）；
  「重跑」= 服务端 RERUNNABLE；「取消」= 没结束的都行；取消与重跑走二次确认。错误原文先说哪一步：估价没过（比最近一次出片新时优先）/ 出片失败 · code / Agent 写稿停下：人话原因。
  变体任务的事件推在它自己的主题上，页面在有变体「会自己变」时每 3 秒重拉，另听模板主题的 variants / estimate / build 事件；一批在本次打开页面期间从没结束变成全部结束（完成 / 失败 / 已取消）时弹一条 toast。
  行不可点，8.4 接上素材审核面板。已知 LOW：有错误展开箭头的行，状态列比列头右移一个箭头宽（客户页同样结构）。
- `clone-studio/web/src/components/variants/AssetReviewPanel.tsx` + `AssetCard.tsx` + `AssetLightbox.tsx` + `lib/variant-review.ts`（8.4）— SCREEN-007：④ 的 `?variant=<id>` 打开全幅面板，
  队列与提交区只藏不卸（草稿、筛选保留），返回时只去掉这个参数、焦点回到那一行（被筛掉就回到队列）；打开时焦点落到标题。左 65% 素材网格 CMP-005（无来源 / 已替换 / 缺口角标、来源域名链接、
  悬停与聚焦出替换 / 看大图，文件输入在前、标签用 peer-focus-visible 画焦点环），右 35% 台词全文 + 估价卡 + 出片卡 + 动作区。估价卡只在闸门前（待确认、素材通过后排队——`VariantView.approved`
  分清「写稿前的排队」、估价没过又没出过片），过了闸门换出片卡，同 ② 复刻页。替换进行中、素材通过提交中互相锁住；取消该变体走二次确认；一个动作成功就清掉别的动作的旧错误。
  面板里的批次已花不含这条自己（估价卡会把它加回去），和闸门看的是同一个数；批次已花只算有运行文件的出片单位的估价（重跑后旧稿的估价不再占钱，8.4 第三轮审查顺带修）。
  **推迟（8.4 审查定下，归 Phase 9 交接）**：Design-Brief §2.3「抽屉跟随当前所选对象，在 007 显示该变体的任务」、CMP-009 熔断 / 中断横条在 007、CMP-008 花费明细在 007——
  抽屉与横条的取数整条是按模板走的（`routes/agent-jobs.ts` 模板的 agent-job、`AgentFeedProvider`），改它是跨页面的改动，不在 8.4 的交付清单里；变体的继续 / 重跑 / 重试出片在 ④ 的队列行上都有。
  停下的变体在面板里写明停因（`lib/variants.ts` 的 `stopReason`，与队列行展开原文共用：估价比最近一次出片新而没过→「估价没过」、出片失败交给出片卡、Agent 写稿停下），面板里只给看、不给继续 / 重跑（归上面的 CMP-009）。
  另留 Phase 9：手改地址 `?variant=` 成别的模板的变体 id 时面板照样打开（审查 LOW，需服务端在 review 里带 templateId 再比对）；加载态是一行字不是骨架屏。
- `clone-studio/server/src/services/variant-review.ts` + `routes/variant-assets.ts` + `lib/image-tool.ts`（8.2）— 素材审核：审核状态（素材卡、台词全文、哪些动作能做与原因）、看图（变体目录内、nosniff）、
  替换单张（先判能不能换再收文件；按实际编码只收 jpg / png / webp；ffprobe 原图定尺寸，原图不在就报错不猜；ffmpeg 放大后居中裁切写进服务端生成名字的中间文件、`-update 1` 防 %d 展开；
  转换完再核一次状态，rename 写回原文件名——换目录项，不顺着硬链接写出去；Windows 上原图被占用报 409；不起 Agent，AC-015）、
  素材通过（有缺口不行；写上运行文件、回排队，交给 6.3 估价闸门与 6.4 执行器；估价出错记日志）、打回（先刷新 `USER_ASSETS.json` 再 resume 该变体会话）、
  重跑（估价进行中不许；清 Agent 产物、运行文件清掉、按原提示与模型开新会话）。估价结论只落到有运行文件的出片单位上，重试出片也要求有运行文件（8.2 审查 M1 / M2）；
  没有运行文件时变体视图不给旧稿的估价与出片。

**验收标准**：
- AC-014、AC-015、AC-016、AC-018、AC-019 通过
- 一个已验货模板提交 3 条 brief，全程只在素材审核处人工介入，至少 2 条产出 mp4

**Phase 8 收口（8.5 真机，2026-09-24）**：
- 环境：数据根设为短路径临时目录 `%TEMP%/cs-acc8`，后端 4413、vite 5174（scratch 里的独立配置，只读工作区源码）、独立无头 Chrome 9333 + CDP；真实服务 4310 / 5173 没碰。
  已验货模板「手机品牌排行」是手写的排行榜模板（3 个条目各 3 秒、720×1280、本机渲染，出片 $0）。
- AC-016：页面上填 21 行，按钮置灰为「提交 21 条变体」，提示「一次最多 20 条，现在是 21 条」，点了也不发请求；直接打 `POST /api/templates/:id/batches` 返回 400 `BRIEFS_TOO_MANY`。备份 API 读库：批次 0、变体 0。
- 3 条 brief 在页面上提交，模型选 Sonnet 5。队列立刻是两条「Agent 写稿中」、一条「排队」（并发上限 2 真机对上），前一条进素材待审后第三条开跑。
  写稿耗时 3:40 / 4:51 / 8:50，三条都一次过宿主判据进素材待审（联网图 9 张，来源有 baike / huawei / wikimedia / amazon / bose，没有缺口）。
- 素材审核是唯一的人工介入：面板里给「小米15 Ultra」换了一张 1600×1200 的 png，落盘仍叫 `03-xiaomi-15-ultra.jpg`、1080×1080 mjpeg，md5 变了，卡片出「已替换」、来源写「你上传的图」；然后三条逐个点「素材通过」。
- 估价三条都是 $0 自动放行，本机渲染出片 3 条，ffprobe：都是 h264 720×1280 30fps 270 帧 + aac，时长 9.000s。
  替换过的那条 0–3 秒（No.3 · 小米15 Ultra）截帧就是上传的测试图，No.2 / No.1 仍是联网图；这条的 Agent 任务始终只有一条、花费一直是 $0.8025。
- AC-014 并发、AC-018 超单条限额待确认、AC-019 批次限额之后全部停靠：自动化测试取证，`variants.test.ts`、`scheduler.test.ts`、`gate.test.ts`、`estimate-run.test.ts`、`variant-review.test.ts` 里带这几个编号的 9 条全过。
- 花费（订阅等价，全部标「估」）：三条变体写稿 Sonnet $0.80 + $1.14 + $1.42 = $3.36；出片本机渲染 $0；没调用任何付费生成服务。
- 编译与测试：仓库根 `pnpm run check` 退出 0。prettier 通过；eslint 0 错误，2 条警告是既有文件（Toast 等）的 fast-refresh 提示；两个包 tsc 0；server 747 通过 4 跳过、web 409 通过。
- 收尾：`hypit runtime down` 已跑。`programs status` 里 WhisperX 本来就是 down，另外两个是本机装好的工具，所以没跑 `programs down`，免得碰共享安装。后端、vite、无头 Chrome 按记下的 PID 停掉，临时数据根已删。
- 真机看到一次后端卡顿：前一条出片刚结束、下一条紧接着开始（`12:59:38–13:00:05 UTC`），27 秒里后端日志一条请求都没有，页面上出了「后端未响应」。
  之后单条出片时每 0.5 秒打一次 health，延迟一直在 300ms 以下，没有复现。静态看出片路径里没有长时间的同步调用，原因还没查到，留给 Phase 9。

**给 Phase 9 的交接（Phase 8）**：
- 007 上的三项推迟：抽屉跟随所选变体（Design-Brief §2.3）、CMP-009 熔断 / 中断横条、CMP-008 花费明细。抽屉与横条的取数整条按模板走（`routes/agent-jobs.ts`、`AgentFeedProvider`），要改成按所选对象取。
- 8.4 的 LOW：手改 `?variant=` 能在别的模板下打开变体面板（review 要带 templateId 再比对）；面板加载态是一行字不是骨架屏；素材卡上传标签 `pointer-events-none` 时禁用原因的 title 看不到。
- 8.3 的 LOW：有错误展开箭头的行，状态列比列头右移一个箭头宽。
- 出片接力时的后端卡顿（见上）：Phase 9 做成片库时顺带用两条及以上的连续出片复现一次，抓 CPU profile。
- 成片的文件名是 `<kind>-v<version>-<buildId 前 8 位>.mp4`，变体的 version 目前都是 1；成片库要用变体名称做展示名（REQ-007 默认名称取 brief 前 20 字）。

---

## Phase 9: 成片库、下载与花费明细（REQ-007、REQ-009，设计稿"⑤ 成片"） ✅

**交付内容**：
- 实现 ⑤成片 网格：封面帧（ffmpeg 抽帧）、名称就地改、时长、花费、状态、筛选、多选
- 实现播放弹层与花费明细 CMP-008（Agent 任务与 Build 两张表、"估"徽标、合计）
- 实现单条下载与多选打包 zip；成片删除（连带文件）
- 模板页头与客户页显示累计花费

**关键文件**：
- `clone-studio/server/src/routes/outputs.ts`、`server/src/services/{outputs,output-store,output-meta,output-costs,output-zip,output-delete}.ts`、`server/src/lib/content-disposition.ts`（9.1）
- `clone-studio/web/src/pages/steps/OutputsStep.tsx`、`web/src/components/outputs/{OutputCard,OutputPlayer,CostBreakdown}.tsx`、`web/src/lib/outputs.ts`（9.2）

**Task 拆分（2026-09-25）**，按序做，每个走 review→fix 循环，两阶段 PASS 后单独 commit：

| Task | 内容 | 覆盖 | 状态 |
|---|---|---|---|
| 9.1 | 成片库后端（server）：`GET /api/templates/:id/outputs`（复刻片各版本 + 变体，出过片或在流水线里的；名称、版本、状态、「已被 vN 取代」、时长、封面地址、合计花费与「估」、能否下载）；封面帧与时长（ffmpeg 抽帧 / ffprobe，后台取、同时最多 2 个，取完推 outputs 事件；缓存到 builds 上，确定取不到给占位，工具不在 / 超时不缓存下次再试）；`GET /api/productions/:id/cover` 封面帧；`PATCH /api/productions/:id` 改名（去首尾空白 1-60 字）；`GET /api/productions/:id/video` 播放与下载（Range、`?download=1` 带 Content-Disposition 成片名）；`GET /api/productions/:id/costs` 花费明细 CMP-008（Agent 任务：模型、时长、等价花费；Build：通道 / 模型、估价、实际、build-id、receipt 链接；都标「估」；合计）；`GET /api/templates/:id/outputs/zip?ids=` 多选打包（GET 让浏览器直接下载）（仅完成且文件在的，zip 内文件名 = 成片名，非法字符替换、重名加序号，store 不压缩、流式写出）；`DELETE /api/productions/:id/output` 删成片文件（真实路径校验在数据根 clients 下、不顺链接），成片从库里隐藏，花费仍计入累计、成片数不算；变体里失败 / 中断 / 熔断的一并作废；失败 / 中断的复刻片不能删（去 ② 重试出片或 ③ 打回）；排队、待确认的复刻片也列进网格；③ 不能通过删掉成片的那一版。Spec 同步 | REQ-007、REQ-009、AC-020/021/024 后端 | ✅ 五轮 review→fix，第五轮两阶段 PASS（首轮 1 HIGH：删掉失败的变体成片后还能重试 / 重跑、花钱出看不见的片，外加 5 MEDIUM：封面文件不在时 500、工具没装 / 超时的失败被永久缓存、第一次打开无上限起 ffmpeg 并等它、卡片与明细两套算钱、删掉的成片还算成片数；第二轮 2 MEDIUM：文件被占用时删除 500 且带绝对路径、③ 对删掉成片的那版仍给通过与播放；第三轮 1 HIGH：删失败的复刻片会让模板卡死在复刻中，外加排队的复刻片没列、③ 仍显示已出片；第四轮 1 MEDIUM：③ 在打回不可用时仍提示打回；第五轮只剩 LOW，当场收）。变异自检 49 条全杀（独立拷贝） |
| 9.2 | ⑤ 成片页（web）SCREEN-008：6 列竖屏封面网格（卡片下名称 + 时长、状态点 + 花费「估」）、筛选（全部 / 完成 / 进行中 / 失败）、多选与「已选 N」「批量下载 zip」、名称就地改、居中播放弹层 + 右侧花费明细 CMP-008、单条下载、删除走二次确认；空态一句话 + 去 ④ 的链接、加载封面骨架、失败卡片红色状态点开看错误原文与重试出片 | SCREEN-008、CMP-008、AC-020/021/024 前端 | ✅ 七轮 review→fix，第七轮两阶段 PASS（首轮 5 MEDIUM：列数没按 6 / 4 / 8、删除没走 CMP-012、状态字号、流水线状态统称「等估价」、服务端必拒的删除仍给点，另一次重拉失败会拆掉整页与播放弹层；第二轮：删后下一条自动弹删除确认、熔断的给重试；第三轮：重跑后又失败仍给重试、状态裁切无省略号；第四轮 1 HIGH：估价没过被说成 Agent 停下、复刻片指去 ④（改由服务端下发停因 stop 与 retryable）；第五轮 1 HIGH：错误区 max-w-md 塌成 12px（加守卫测试禁用具名尺寸类）、「估」掉行、金额溢出、停因码没翻译；第六轮：状态与花费不同行、通道列看不清、封面被裁；第七轮只剩 LOW，当场收）。后三轮每轮都在无头 Chrome 里实测 1280 / 1600 / 抽屉展开三种宽度。变异自检 web 40+ 条、server 6 条全杀（独立拷贝） |
| 9.3 | Phase 8 交接（web + server）：Agent 抽屉跟随所选对象（在 007 显示该变体的任务，Design-Brief §2.3）；007 上 CMP-009 熔断 / 中断横条（继续 / 重跑）与 CMP-008 花费明细；`?variant=` 属于别的模板按不存在处理；面板加载态骨架屏；素材卡禁用原因看得见；④ 队列有展开箭头的行状态列与列头对齐 | Design-Brief §2.3、CMP-008/009、8.3 / 8.4 LOW | ✅ 四轮 review→fix，第四轮两阶段 PASS（首轮 3 MEDIUM：别的模板的 `?variant=` 仍驱动抽屉与重跑、已取消的变体仍给继续 / 重跑、007 花费明细不刷新——服务端加 ownerGate（所属模板 + 此刻能否继续 / 重跑）随快照与任务头下发，变体重跑前校验是最新任务；第二轮 2 MEDIUM：gate 只在加载时算，面板里取消、或任务无消息地停下后横条过期——改为变体的 variants 事件与同任务状态变化时重拉任务头；第三轮只剩 LOW：测试文件拆分、重复帧不重拉、不存在的变体抽屉单独说；第四轮只剩可选 LOW）。真机测出抽屉展开时 007 右栏放不下 CMP-008 表格、把工作区撑出横向滚动，改为容器宽度 <300px 时逐行折叠。变异自检 web 26 条、server 9 条全杀（独立拷贝，工作区 md5 未变） |
| 9.4 | 出片接力卡顿排查：隔离环境连续 ≥2 条本机出片，事件循环延迟探针 + `--cpu-prof`，定位并修掉；修后同场景延迟 <1s。复现不了则留 ≥3 次尝试的数据记为风险 | Phase 8 真机遗留 | ✅ 两轮 review→fix，第二轮两阶段 PASS。根因：出片结束时 `stopActivityWatcher → killTree → forceKillTree` 用 `spawnSync("taskkill /T /F")` 同步等整棵进程树杀完，堵住事件循环（机器忙时更久，Phase 8 那次 27 秒）。隔离环境连续 3 条本机出片取证：修前 CPU profile 长任务 686 / 630 / 461ms、探针最高 540ms；修后长任务（≥150ms）0 段、每分钟最高 147 / 53ms。修法：平时异步起 taskkill、等它结束但不堵事件循环（封顶 30 秒），只有后端退出收尸同步（首轮 MEDIUM：删目录前要等 taskkill 杀完孙进程；第二轮 MEDIUM：一条用例在高负载下和 exit 事件赛跑）。变异 4 条全杀 |
| 9.5 | Phase 9 真机验收与收口：隔离环境已验货模板（本机渲染），≥3 条完成成片；AC-020 页内播放 + 下载 ffprobe；AC-021 勾 3 条打包下载解包核对；AC-024 变体详情两笔花费与合计均标「估」；改名、删除（文件真的没了）、累计花费页头与客户页一致；四步验证 | Phase 9 验收标准 | ✅ 真机（2026-09-25，见下「Phase 9 收口」） |

**验收标准**：
- AC-020、AC-021、AC-024 通过

**Phase 9 收口（9.5 真机，2026-09-25）**：
- 环境：数据根设为短路径临时目录 `%TEMP%/cs-acc9`，后端 4413、vite 5174（scratch 里的独立配置，只读工作区源码）、独立无头 Chrome 9333 + CDP；真实服务 4310 / 5173 没碰。
  已验货模板「手机品牌排行」（本机渲染，出片 $0）出了 9 版复刻片（9 秒、h264 720×1280），外加 1 条 Sonnet 真实写稿的变体（15 秒）。
- AC-020：⑤ 里点开「复刻片 v3」，页内播放器 readyState 4、播到 1.52s、720×1280、时长 9s；弹层里点「下载」得到 `复刻片 v3.mp4`，ffprobe：h264 720×1280 30fps + aac，9.000s。
- AC-021：先在网格里就地把 v1、v2 都改成「耳机/排行:终版」（同名、带非法字符），勾这两条加 v3，工具条「已选 3」，点「批量下载 zip」得到 `手机品牌排行.zip`。
  解包是 `耳机_排行_终版.mp4`、`耳机_排行_终版 (2).mp4`、`复刻片 v3.mp4`：文件名就是成片名，非法字符换成 `_`，重名加序号；三个 ffprobe 都正常。本机渲染同一套稿子，三个文件字节一致（md5 相同），所以真机只证明了命名、去重、非法字符与可播放；每个条目装的是对应成片的内容由 `output-files.test.ts`「内容原样」用例保证。
- 删除：播放弹层里「删除成片」→ CMP-012 输入「复刻片 v4」确认，网格 9 → 8，输出目录里 `replica-v4-*.mp4` 与 `.cover.jpg` 都没了。
- AC-024：变体「2026 年最值得买的 5 款降噪耳机排行」写稿 7:39，联网图 5 张，素材通过后本机出片。花费明细：Agent 任务 claude-sonnet-5 · 7:39 · $2.15「估」，出片 本机渲染 · 估价 $0.00「估」· build-id `bld_20260925T044612874Z_BDFB890AC2`，合计 $2.15「估」。
  ⑤ 播放弹层与 007 右栏两处一致，007 的抽屉跟着这条变体的任务（完成卡「用时 7:39 花费 $2.15（估）」）。
- 累计花费：模板页头「模板累计 $2.15 估」，客户页这一行「成片 2 · 累计花费 $2.15 估」，一致。
- 真机抓到并在 9.3 里修的：抽屉展开时 1280 / 1440 宽下 007 右栏约 200px，CMP-008 表格最窄 251px，把整个工作区撑出横向滚动（1280 下 605 → 725）。改为容器 <300px 时逐行折叠，修后四种宽度都没有横向溢出；⑤ 播放弹层（360px）仍是表格。
- 花费（订阅等价，全部标「估」）：Agent 写稿 Sonnet $2.15；出片全部本机渲染 $0；没调用任何付费生成服务。
- 收尾：`hypit runtime down` 已跑（Managed Programs 是本机共享安装，没跑 `programs down`）；后端、vite、无头 Chrome 按记下的 PID 停掉，临时数据根已删。
  另查出测试临时目录泄漏：`review-edge.test.ts`「已验货后换参考视频」没等新一轮证据跑完就收尾，证据流水线在目录删掉之后写库又把目录建出来；改成等证据跑完，连跑三遍 0 泄漏。清掉历次积下的 217 个 `cs-*` 临时目录（含变异与审查拷贝留下的）。
- 四步验证：
  1. Code Review：9.1～9.4 各自 code-reviewer 两阶段 PASS 后单独提交（9.1 五轮、9.2 七轮、9.3 四轮、9.4 两轮），9.5 的改动（测试临时目录泄漏修复、9.3 可选 LOW、收口文档）另过一轮两阶段 PASS，只剩文档措辞 LOW 当场改；对照上面交付内容四条逐项落地，没有超范围改动（9.3 的交接项本就列在拆分表里）。
  2. 测试完整性：抽帧失败 / 工具不在不缓存、缺文件的成片、zip 重名与非法字符、删除只删本条文件（路径在数据根 clients 下、不顺链接）、花费合计与「估」、⑤ 空态 / 错误态 / 加载骨架、007 跟随变体与 gate 变化都有用例真走到；变异自检全在独立拷贝里跑、工作区 md5 未变（9.1 49 条、9.2 web 40+ / server 6 条、9.3 web 26 / server 9 条、9.4 4 条，全杀）。
  3. 编译：两个包 `tsc --noEmit` 0 错误。
  4. 功能：真机见上。仓库根 `pnpm run check` 退出 0：prettier 通过；eslint 0 错误，2 条警告是既有文件的 fast-refresh 提示；web 45 个文件 474 通过；server 76 个文件 805 通过、4 跳过。

**给 Phase 10 的交接（Phase 9）**：
- CMP-008 的 Agent 任务表现在只显示模型 id；REQ-010 要求台账可见档案名，做档案时在花费明细里加档案名一列（窄栏折叠时一并处理）。
- 抽屉的「重跑」现在按原模型；档案落地后变体重跑也走 CMP-010 选择（`POST /api/agent-jobs/:id/rerun` 已按所选对象分流到 `rerunVariant`）。
- 同一次任务状态变化会从 `job:` 与 `production:` 两个主题各推一帧，前端已按状态去重；SSE hub 没做按连接去重，量大时再看。
- 风险（Phase 10 真机又出现一次，见「Phase 10 收口」）：验收脚本快速连跳页面时出过一次「后端未响应」，当时后端 4.7ms 就回了、健康检查正常，怀疑是 vite 代理上旧页面的 SSE 连接没及时释放、占满浏览器同源 6 连接；之后连跳 3 次、每页只有 2 条 SSE，没再出现。只在开发代理下见过。
- 9.3 第四轮审查的可选 LOW 已在收口时顺手做掉：窄栏 Agent 行也写列名、时长列放宽到 72px（1 小时以上的 h:mm:ss）、单测直接断言 `missing`。时长列加宽这一处没有在浏览器里复看（验收环境已收掉）：⑤ 弹层的模型列约 184px 不受影响，要留意的是 007 右栏容器刚过 300px 时模型列只有 124–154px，长模型 id 会走截断 + 悬停全文。

---

## Phase 10: Agent 模型档案与切换（REQ-010） ✅

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

**联网核实（2026-09-25）**：
- 豆包方舟（Q-004）：火山方舟官方文档「Coding Plan 个人版」（docs.volcengine.com/docs/82379/1928261）给出 Anthropic 兼容地址 `https://ark.cn-beijing.volces.com/api/coding`，模型可填 `ark-code-latest`（控制台选模型）；只消耗 Coding Plan 额度，文档明说不要用 `/api/v3`（那是另行计费的通用接口）。预设按它写。
- DeepSeek：官方文档（api-docs.deepseek.com，Claude Code 接入与 Anthropic API 两页）地址 `https://api.deepseek.com/anthropic`，图片块 base64 / url 支持、web_search 工具支持；模型 `deepseek-flash`，claude-opus 前缀映射到 `deepseek-v4-pro`。
- Claude Code 三档映射变量：`ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`，鉴权 `ANTHROPIC_AUTH_TOKEN`（Bearer）；Anthropic 官方 key 用 `ANTHROPIC_API_KEY`。
- SDK 0.3.278：result 带 `modelUsage`（按模型累计 input / output / cache 读写 token），assistant 消息带每次调用的 `usage`——单价熔断据此折算。

**Task 拆分（2026-09-25）**，按序做，每个走 review→fix 循环，两阶段 PASS 后单独 commit：

| Task | 内容 | 覆盖 | 状态 |
|---|---|---|---|
| 10.1 | 档案存储与接口（server）：迁移 v10 种入内置「本机 Claude Code 订阅」（builtin、默认、不可删）、`agent_jobs.profile_id`；预设清单（本机订阅 · 指定模型、Anthropic API key、DeepSeek、豆包方舟、Gemini / OpenAI 经 LiteLLM、自定义，带默认能力与「需要 API key，聊天订阅不可用」）；`GET/POST/PATCH/DELETE /api/model-profiles`、设为默认；校验按 REQ-010 输入表（名 1-30 字不重名、base_url http/https、token、主模型、单价 ≥0）；token 只进 secrets.json、接口回打码；改 base_url / token / 模型后清掉「已验证」；删被引用的档案不动历史任务快照；「测试连接」：订阅走一次最小 SDK 会话，其余直接打 `{base_url}/v1/messages`（声明看图时带一张测试图），失败回上游状态与错误原文、标未验证，成功标已验证时间。Spec 同步（Q-004 定稿） | REQ-010 档案、AC-028、AC-030 | ✅ 两轮 review→fix，第二轮两阶段 PASS（首轮 2 MEDIUM：改过配置后再点测试会搭上旧配置那次探测、把新配置标成已验证；带换行的 token 会让请求头报错把明文回显到界面——改为去重键带 updated_at、token 只收可见 ASCII 并在回显里打码；顺手收了看图打开清已验证、2xx 必须是 Messages 消息、按字符数算名长等 LOW）。另加「本机订阅 · 指定模型」档案（替换 Phase 8 过渡模型清单时仍能在订阅下选 Sonnet）。第二轮剩的 LOW（base_url 带查询串、JSON 转义形式的 token 回显、文件 305 行）并进 10.2。变异自检 34 条全杀（独立拷贝）。顺带修掉两处测试临时目录泄漏（evidence「超时标 timeout」没等重试跑完），清掉历次积下的 582 个 `clone-studio-*` 目录 |
| 10.2 | 运行器按档案跑（server）：档案 → 子进程环境（订阅不注入任何变量；Anthropic key 只注入 `ANTHROPIC_API_KEY`；兼容端点注入 BASE_URL / AUTH_TOKEN / MODEL 与三档映射，并去掉订阅令牌 `CLAUDE_CODE_OAUTH_TOKEN`），每个会话单独算、不碰 process.env；AgentJob 建立时写档案 id / 名 / 模型快照；继续、打回、额度续跑沿用原档案（档案已删或凭据没了就说明只能重跑）；重跑可带档案参数（模板与变体都行）；复刻拦截不支持看图的档案、不建任务，变体只提示；不支持联网搜索的档案在系统提示里改用 Bash / WebFetch 找图；单价熔断：非订阅档案按 usage × 单价折算花费与熔断，单价为空不做 $ 熔断并在任务上标明；①参考提交与 ④变体提交收档案 id（替换 Phase 8 的过渡模型清单）。Spec 同步 | REQ-010 运行、AC-025/026/027/029 后端 | ✅ 三轮 review→fix，第三轮两阶段 PASS（首轮 2 MEDIUM 功能：过渡的「模型 id」提交验的是默认档案而不是它实际跑的订阅；①参考 不选档案时不验也不记默认档案；2 MEDIUM 安全：读凭据变量 / 导出环境的拦截太好绕；第三方模型驱动时 Agent 能读 Claude Code 自己的登录凭据文件——补了拦截与凭据文件保护，消息 / 停因 / 拦截记录打码。没用 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB：它会把权限模式强制改回 default（anthropics/claude-code#51258），无头会话每个工具调用都会卡住。第二轮 1 MEDIUM：拦截仍漏带选项 / 引号 / Git Bash 的 `cmd //c` / PowerShell `-Path env:` 等写法，另有几处误伤读单个变量——收紧后第三轮只剩 LOW）。审查中顺手：校验拆到 profile-validate.ts、等额度续跑拆到 quota-wait.ts（scheduler.ts 守在 300 行内）。变异自检 server 约 64 条全杀（独立拷贝；变异脚本跑完清掉被杀变异体留下的临时目录） |
| 10.3 | 设置页「Agent 模型」分区（web）SCREEN-009：档案表（名称、类型、模型 id、看图 / 搜索徽标、已验证时间、默认标记，行内测试连接 / 设为默认 / 删除）；「+ 添加模型」右侧表单面板先选预设，固定一行「需要 API key，聊天订阅不可用」，LiteLLM 预设给起代理说明；编辑、token 打码回显；测试连接失败展开上游原文；删除走 CMP-012；空态（只有内置订阅）、加载、错误 | SCREEN-009、REQ-010 界面、AC-028 前端 | ✅ 三轮 review→fix，第三轮两阶段 PASS（首轮 4 MEDIUM：删除确认框里按 Esc 连面板与草稿一起关、两行同时测试时前一行的转圈被抢、1280 宽下行内动作换行不齐且截断不生效、面板打开焦点没进去关掉也不回来；第二轮 1 MEDIUM：落焦按整份文档匹配 `main button` 撞上外壳 <main> 里的「关闭」，回车就丢草稿——改为只在面板内容区里找、编辑时不拉预设；另收了测试期间被改的结论只提示、请求没成不说标了未验证、失败原文随配置变化收起、删了正在编辑的档案面板跟着关、换编辑对象焦点还给对的按钮）。变异自检 web 30 条全杀（独立拷贝）。真浏览器外观留 10.5 |
| 10.4 | CMP-010 档案选择器接入（web）：①参考导入表单、④变体提交区、抽屉 / CMP-009 重跑确认框（模板与变体，默认原档案）；项 = 档案名 + 模型 id 小字 + 看图 / 搜索徽标，不满足任务要求的置灰写原因（复刻要看图），底部「管理模型…」；首次切到非 Claude 档案提示 hypit skill 按强模型设计；抽屉页头与 CMP-008 Agent 表显示档案名（窄栏折叠同步）；素材审核在无原生搜索的档案下提示「素材缺口可能偏多」 | CMP-010、AC-026/027/029 前端、Phase 9 交接 | ✅ 三轮 review→fix，第三轮两阶段 PASS（首轮 5 MEDIUM：重跑对老任务默认成默认档案、丢了 Phase 8 的 Sonnet；「未知」只在花费明细；读不到档案停在「读取中」；按单价折算看不到运行中的输出 token（假端点实测 SDK 的 assistant 消息里输出只记 1，改为只对按单价的会话开流式事件读 message_delta，事件不落库）。第二轮 3 MEDIUM：抽屉结束卡仍写 $0、重跑框读不到档案时的说明不对、代理不回消息 id 时流式输出接不上。第三轮只剩 LOW）。撤掉 Phase 8 过渡模型清单（/api/agent-models 下线、提交只收档案 id）。变异自检 web 39 条、server 13 条全杀（独立拷贝） |
| 10.5 | Phase 10 真机验收与收口：隔离环境；AC-025 默认复刻记为订阅档案；本地假 Anthropic 兼容端点记下收到的路径、token、模型，AC-026 注入正确且同时一条订阅任务不受影响，AC-028 错 key 回 401 原文标未验证；AC-027 页面拦截；AC-029 熔断后继续用原档案、重跑可重选；AC-030 删档案后历史不变；四步验证 | Phase 10 验收标准 | ✅ 真机（2026-09-25，见下「Phase 10 收口」）+ PriceMeter 压缩计价修复（Spec v1.10.3）；两轮审查，第二轮两阶段 PASS |

**验收标准**：
- AC-025 至 AC-030 通过

**Phase 10 收口（10.5 真机，2026-09-25）**：
- 环境：数据根设为短路径临时目录 `%TEMP%/cs-acc10`，后端 4413、vite 5174（scratch 里的独立配置，只读工作区源码）、独立无头 Chrome 9333 + CDP，本地假 Anthropic 兼容端点 4499（把每次请求的路径、token、模型、是否流式、是否带图记进 jsonl；`sk-fake-bad-*` 回 401 原文，`sk-fake-heavy-*` 每次回 300 万输入 / 100 万输出 token）。真实服务 4310 / 5173 与真实数据根没碰；没用任何真实第三方 key。
- AC-025：新模板导入参考视频、不选档案，证据跑完自动起复刻任务，任务快照 `profileId=subscription`、档案名「本机 Claude Code 订阅」、花费口径 sdk；跑约 24 秒后中止，等价花费 $0.27。这一条用的是内置订阅档案的默认模型、不是约束里写的 Sonnet：AC-025 验的就是默认安装的路径，偏离如实记在这里。
- AC-026：同一模板下先提交一条变体用「订阅 · Sonnet」（本机订阅指定 claude-sonnet-5），它在跑时再提交一条用「假端点 A」，10:10:04–06 两条同时是 running。假端点只收到「假端点 A」的请求：路径 `/anthropic/v1/messages`、token `sk-fake-good-aaaa1111`、模型 `fake-model`、流式；订阅那条没有任何请求打到假端点。假端点那条任务记「假端点 A / fake-model」，按单价折算 $0.00124「估」（假端点只回一句话，变体判据没过记失败，符合预期）。
  截图：抽屉页头「假端点 A · fake-model」、CMP-008 Agent 行带档案名、无原生搜索提示；订阅那条页头「订阅 · Sonnet · claude-son…」运行中（抽屉窄，模型 id 截断，悬停 title 是全称 claude-sonnet-5）。订阅变体随后中止，等价花费 $0.52。
- AC-027：`POST /api/templates/:id/evidence` 带「看不见」（没开看图）回 400 `PROFILE_NO_VISION`，前后查这个模板都没有 AgentJob、模板没被改动；① 表单的 Agent 模型下拉里「看不见」置灰，写着「不可选：不支持看图，复刻要看参考视频的帧」。④ 选「看不见」只出提示（素材审核多看一眼、无原生搜索），不拦；变体用不看图的档案照常建任务由 `scheduler-profile.test.ts`（变体不要求看图）与 `ModelSelect.test.tsx`（不看图的能选、选了提示）保证（截图里按钮灰是因为还没填 brief）。
- AC-028：接口测「假端点 错 key」回 `{ok:false,status:401,detail:<上游原文>}`、verifiedAt 为空（当场输出，没另存文件；截图里的「未验证」与假端点日志 `hasImage:true` 可复查），请求带了测试图；设置页点「测试连接」后该行展开「测试连接失败，档案标为未验证：HTTP 401 …invalid x-api-key…」，好 key 那行「已验证 · 2 分钟前」。
  顺带用无头 Chrome 看了 10.3 留下的外观：1280 宽下档案行动作一行排开、徽标与打码 token 不挤；添加面板顶部固定「需要 API key，聊天订阅不可用」，七个预设带说明（LiteLLM 两项写了起代理的命令）。
- AC-029：先把 Agent 熔断设成 $2，用「假端点 重」提交一条变体：第一次调用折算 $4，任务「已熔断：超预算：花费达到上限（按档案单价折算）」。「继续」后假端点又收到 `sk-fake-heavy-bbbb2222` 的请求，任务仍记「假端点 重」，再次熔断到 $8。
  每次继续上游收到的是 **两次** heavy 请求（4 → 6 次），花费却只加了 $4：审查指出后用 SDK 直连假端点复现，多出的那次是 SDK 的自动压缩（假端点每次报 400 万 token，超过 200k 上下文，resume 时先压缩；请求里是「Respond with TEXT ONLY」的摘要提示）。压缩那次调用不出 assistant 消息、不出流式事件，result 的 usage 也不含它，所以按单价折算漏了它；真实长会话接近上下文上限时同样会压缩。已修：`PriceMeter` 按 `compact_boundary` 的 pre_tokens 记输入、post_tokens 记输出，另外加上（运行中就记，熔断能判到）。修后同一复现 resume 那段折算 $8.0007，和上游两次调用对得上（修前 $4；spike 输出当场贴在会话里、没另存，脚本 spike3 / spike4 与假端点请求日志留在 scratch）。单测 5 条（含调度器里压缩超线就熔断），变异 6 条全杀（独立拷贝，工作区 md5 未变）。Spec v1.10.3 同步。
  先跑的一条「熔断用的一条」（ed7524ed）是熔断还是 $5 时提交的：第一次 $4 没超线，继续后累计 $8 也没熔断，最后判据没过记失败——下面 AC-030 的「一条失败」就是它。
  在 SCREEN-007（素材审核）的 CMP-009 横条点「重跑」，确认框里的档案下拉默认是原档案「假端点 重」，改选「假端点 A」确认后新任务记「假端点 A」，重跑之后假端点只收到 `sk-fake-good-aaaa1111`。确认框里同时出了首次切到非 Claude 档案的提示。
- AC-030：两条用过「假端点 重」的历史任务（一条失败、一条熔断）删档案前后对比：档案 id、档案名、模型 id、花费口径、花费和花费明细里的档案名完全一致；档案列表里没了它，secrets.json 里它的 key 也跟着删掉。对这条已删档案的任务点「继续」回 409 `PROFILE_GONE`「原档案「假端点 重」已经删了，只能重跑（可以重选档案）」。页面上抽屉页头、CMP-008、④ 队列行仍显示「假端点 重 · fake-model · $8.00 估」。
- key 不外泄（真机补查，grep 结果当场贴在会话里、没另存）：四个假 token 在数据根里只出现在 secrets.json（已删档案的那个也不在了），数据库（备份 API 取的副本）、工作目录、后端日志里都是 0 次（数据库副本与日志审查时复查过）；`GET /api/model-profiles` 只回 `sk-••••••••••••1111` 这类打码。
- 一次偶发：第一次在设置页点「测试连接」，请求在浏览器里等了 57 秒才到后端（后端日志 18:13:35.8–18:14:33.2 一条请求都没有，同一页的健康检查也等了 5 秒超时，页面 Resource Timing 当场读出、没另存），之后连试三次都在 0.5 秒内回来。症状和 Phase 9 那次不同（那次后端很快回了、健康检查正常），原因**疑似**同一类（无头 Chrome 连跳页面后旧页面的 SSE 连接没放掉、占满同源 6 连接），但没采到连接数证据，没定性。已列进「已知风险」与 Phase 11 交接。
- 花费（订阅等价，标「估」）：真实 Agent 会话 2 条（上限 3），AC-025 订阅默认模型 $0.27 + AC-026 Sonnet $0.52 = $0.79；假端点任务的 $4 / $8 是按假单价折算的，不是真钱；没调用任何付费生成服务。
- 收尾：`hypit runtime down` 与 `hypit programs down`（whisperx 是证据流水线起的，验收前是停的）已跑；后端（及其 tsx 父进程）、vite、假端点、无头 Chrome 按记下的 PID 停掉，4413 / 5174 / 4499 / 9333 都已释放；临时数据根已删（删前确认里面没有 junction），没有泄漏的 `cs-*` / `clone-studio-*` 目录。
- 四步验证：
  1. Code Review：10.1～10.4 各自 code-reviewer 两阶段 PASS 后单独提交（10.1 两轮、10.2 三轮、10.3 三轮、10.4 三轮），10.5 另过两轮审查（首轮 2 MEDIUM：交接里继续的花费和证据对不上——查出是 SDK 自动压缩那次调用漏算，`PriceMeter` 按 compact_boundary 补计、Spec v1.10.3；偶发连接卡住写成了定论、没进已知风险——改为疑似并列入已知风险与交接。第二轮两阶段 PASS，只剩 LOW，已顺手处理：顶部进度与 10.5 行写明代码修复、未存档的证据注明、三处压缩计价边界并入 Phase 11 交接）；对照交付内容逐项落地：档案增删改与默认、内置订阅不可删、七个预设（豆包方舟按联网核实的 Coding Plan 端点写入）、每会话独立注入环境、测试连接、复刻看图拦截 / 变体只提示、无搜索改提示、快照、继续沿用 / 重跑可选、单价熔断与「未知」、设置页分区、CMP-010 接入 ① / ④ / 重跑框、首次切换提示；Phase 9 交接的 CMP-008 档案名与重跑选档案也已做。没有超范围改动。
  2. 测试完整性：每种档案的环境映射（订阅不注入任何变量）、两个并发会话环境隔离、看图拦截、测试连接失败原文与状态、删被引用的档案后历史快照不变、继续与重跑的档案规则、单价折算与单价为空、空态 / 加载 / 错误态都有用例真走到；key 不出现在接口响应、日志、库里明文、工作目录、消息流有专门用例。变异自检全在独立拷贝里跑、工作区 md5 未变（10.1 34 条、10.2 约 64 条、10.3 web 30 条、10.4 web 39 / server 13 条、10.5 压缩计价 6 条，全杀）。
  3. 编译：两个包 `tsc --noEmit` 0 错误。
  4. 功能：真机见上。仓库根 `pnpm run check` 退出 0：prettier 通过；eslint 0 错误，2 条警告是既有文件的 fast-refresh 提示；server 84 个文件（1 跳过）895 通过、4 跳过；web 49 个文件 518 通过。

**给 Phase 11 的交接（Phase 10）**：
- 审查留下的 LOW（都不影响验收）：
  - 素材审核的「无原生搜索」提示按当前档案判断，没有读任务快照：档案事后改了能力，提示会跟着变。
  - 代理不回消息 id 时，assistant 消息的 usage 可能和流式事件重复计一次（取最大值，不会少算，可能多算）。
  - ⑤ 成片卡片与模板累计遇到「未知（没填单价）」的任务，合计里没有标「含未知」。
  - 拦截读凭据变量的残余写法：PowerShell `env:ANTH*` 通配、Git Bash 的 `/c/Users/...` 形式路径。
  - 设置接口没校验 Origin（本机服务，防 CSRF 留给以后）。
  - 第三方端点回 429 按订阅额度处理（会进等额度），没区分。
  - 压缩计价的边界（10.5 第二轮审查）：压缩失败时 SDK 只发 `status` 带 `compact_result: failed`、不发 compact_boundary，那次调用没计上；子 Agent 里的压缩是否上报不确定；没有 post_tokens 时输出记 0。另外 post_tokens 更接近压缩后整段上下文的大小，拿它记输出偏高估，Spec 与注释写的「摘要 token」是近似说法。
- ④ 队列行的花费只算当前这一次任务：重跑之后，之前那次的 Agent 花费只在花费明细与模板累计里（Phase 8 的口径，没改）。
- 单价熔断每次「继续」给一个新的熔断窗口（和订阅的 SDK 口径一致，花费累计显示）：每次继续最多再花一个熔断额度（单次调用就超线的，还会多出那一次调用），任务累计花费可以超过熔断值（真机 ed7524ed 在 $5 熔断下累计到 $8）。
- 偶发的浏览器请求卡住（Phase 9、Phase 10 真机各一次，都在无头 Chrome + vite 代理下连跳页面之后）：下次真机验收开着 CDP 的 Network 事件，卡住时记下挂着的请求与连接，再定性是不是 SSE 占满同源连接。
- 非 Claude 档案只保证接得上、拦得住：真机只用假端点证明了注入与计费，第三方模型写 svml 的成功率没测（没拿到真实第三方 key 的同意，也不在本 Phase 范围）。

---

## Phase 11: Codex 订阅生图 Provider（REQ-011，P1） 🟡 AC-031 待补验

**交付内容**：
- 参照 `hypit-main/examples/provider-package/packages/provider-images` 写项目自有 Provider，承接 `@hypit/gpt-image@1#gpt-image-2`：`start` 里 spawn `codex exec`（参数、Windows 沙箱、`NODE_OPTIONS` 清理、`$imagegen` 单次、10 分钟超时、4 MB 行缓冲全部按 Spec REQ-011），`collect` 经 `context.resources` 交回 PNG；两条找图路径互为兜底；零价 pricing
- ~~hypit 调用统一追加 `--package-root <clone-studio>/providers`~~ → 改为把包同步到数据根 `node_modules`（见下「技术核实」）；启用后 runtime profile 写入 endpoint 与 `bindings`
- 设置页增加 Codex 体检行、启用开关、"试出一张图"；台账记录张数

**关键文件**：
- `clone-studio/providers/codex-image/package.json`、`providers/codex-image/src/activation.ts`、`providers/codex-image/src/provider.ts`
- `clone-studio/providers/codex-image/src/codex-runner.ts`、`providers/codex-image/src/jsonl.ts`、`providers/codex-image/src/locate-image.ts`
- `clone-studio/server/src/hypit/runtime-profile.ts`（从 workspace.ts 拆出）— codex.local endpoint 与 bindings；`server/src/hypit/codex.ts`、`codex-package.ts` — codex 起法 / 体检、包同步
- `clone-studio/web/src/components/settings/CodexImage.tsx`（与 `GenerationServices.tsx`，从 SettingsPage 拆出）

**技术核实（2026-09-25，spike 在 scratch 里跑，hypit 0.2.6）**：
- Provider 形状：`@hypit/hypit/endpoint-kit` 的 `defineEndpointPackage` + `lifecycle: "immediate"`（本机进程，handler 直接回结果，不走 start/poll）；`pricing: { kind: "local" }` → plan 里 `localRequestCount` 计 1、`pricing.kind: local`，现有估价逻辑自动算 $0。
  activation 直接写 `.ts`（`hypit.activation: "./src/activation.ts"`）能被加载：发行版在 CLI 与 Worker 进程里都注册了 tsx，spike 里 plan 解析到 endpoint、build 由 Worker 调到 handler 并把 handler 的错误原文带回 build failure。不用先编译。
- 包怎么让 hypit 找到：`--package-root` 只有 `check / plan / pricing / build` 认；`doctor`、`programs`、`runtime` 都不认，profile 里一出现这个包就报「cannot resolve installed package」——whisperx 的 `programs up`、收尾的 `runtime down`、体检的 `doctor` 全会坏。
  而且已经在跑的 Worker 会被复用、不看新的 package-root。hypit 找包时会从工作目录往上逐级查 `node_modules/<包名>`，所以改为：宿主把 Provider 包同步一份到 `<数据根>/node_modules/@clone-studio/codex-image`（所有模板工作目录都在数据根下），spike 里 doctor / programs status / plan / build 不带任何参数都通过。
  **不追加 `--package-root`**（Spec 与原计划写的是追加，按上面的证据改，Spec 同步）。
- 本机 codex 是 npm 的 `.cmd` 垫片（`%APPDATA%\npm\codex.cmd` → `node …\@openai\codex\bin\codex.js`）；`shell: false` 起不了 `.cmd`，宿主解析出 `codex.js` 用 `node codex.js …` 起，原生 `.exe` 就直接起。
- gpt-image 端口：prompt、aspectRatio（16 种）、resolution（1K / 2K / 4K）、background（transparent / opaque / auto，可省）、images（最多 16 张参考图）。Provider 只收 ≤4 张参考图，background=transparent 回「不支持」（plan 阶段就拒，不起 Codex）。

**Task 拆分（2026-09-25）**，按序做，每个走 review→fix 循环，两阶段 PASS 后单独 commit：

| Task | 内容 | 覆盖 | 状态 |
|---|---|---|---|
| 11.1 | Provider 包（`clone-studio/providers/codex-image`，pnpm workspace 成员，进 `pnpm run check`）：`codex-runner` 按 REQ-011 的参数数组起 codex（`shell: false`、清 `NODE_OPTIONS`、Windows elevated 沙箱、一图一进程、参考图最多 4 张走 `--image`、10 分钟超时杀进程树、JSONL 按行切分单行上限 4 MB、首条 `thread.started` 取 thread_id）；提示词里 `$imagegen` 恰好一次、结尾「仅生成图片…」、要求复制到 `./images/<name>.png`；成败：exit 0 且产物存在且 >0 字节；找图两路互为兜底（`<cwd>/images/<name>.png`、`$CODEX_HOME/generated_images/<thread_id>/` 运行区间内最新 PNG）；JSONL `error` 事件或 stderr 含 rate limit / quota → 失败带原文；exit 0 没图 → 失败带 JSONL 末段；`supports`：透明背景、>4 张参考图、非 gpt-image 端口 → 不支持并写原因；零价 `pricing: local`；activation 配置（codex 命令与前置参数、CODEX_HOME、超时、并发）严格校验。单测用假 codex（node 脚本）驱动，生命周期测试走 hypit 的 EndpointRegistry，不发真实请求 | REQ-011 Provider、AC-032 | ✅ 两轮 review→fix，第二轮两阶段 PASS（首轮 2 MEDIUM：清理临时目录抛错会盖掉原来的结果、甚至把成功判成失败（Windows 上进程还占着目录时 EPERM）——改为带重试、失败只报诊断；JSONL 末段与错误原文不截断，一条 Build 错误最大可到几十 MB——逐行截断、错误最多 8 条。另收：杀了之后没有第二道截止、同步 spawn 异常没前缀、额度原话「usage limit」认不出、超时与单行超长没有 provider 层用例、参考图扩展名。第二轮只剩 LOW，提交前收了两条：codex 已退出但孙进程占着管道时宽限计时不启动（实测复现后修）、截断只留开头会切掉行尾的额度原话（改为留头留尾））。端到端：scratch 里用真实 `hypit build` + 假 codex 出图 complete、`none` 模式 build 失败带 JSONL 末段。变异自检 37 条全杀（独立拷贝，工作区 md5 未变） |
| 11.2 | 宿主接入（server）：Provider 包同步到数据根 `node_modules`（启动时与启用时，只动这个目录、比对内容有变才写、不顺链接）；启用后 runtime profile 写 `codex.local` endpoint 与 `@hypit/gpt-image@1#gpt-image-2` 绑定、并发 1，config 由宿主解析 codex 入口；体检行改为 CLI ≥0.128 且 `$CODEX_HOME/auth.json`（默认 `~/.codex`）存在，只看在不在、不读内容，未过提示 `codex login`；启用开关服务端校验体检，不过不让开；「试出一张图」接口：在临时 hypit 工程里 build 一个只含一个 gpt:Image 的 run，回图、耗时、Codex 原文错误；台账：估价行记张数（gpt-image 走 codex 的请求数）；guard 禁止 Agent 写数据根 `node_modules`。Spec（+CHANGELOG）同步 | REQ-011 宿主、AC-031、AC-033 后端 | ✅ 三轮 review→fix，第三轮两阶段 PASS（首轮 1 HIGH 安全（实测复现）：hypit 找包「离工作目录最近的优先」，Agent 在工作目录写一份同名 `node_modules/@clone-studio/codex-image`，宿主带凭据跑 hypit 时就执行了它——宿主在每次调 hypit 前查从工作目录到数据根的 `node_modules/@clone-studio`、查到就拒绝（SHADOW_PACKAGE），guard 也拦写 node_modules；4 MEDIUM：包没同步上还绑定，所有模板估价与 whisperx 一起坏、体检却显示通过——包在才绑、体检行报原因；后端重启后试图的 Worker 成孤儿、下次试图裸 500——启动与每次试图前先 runtime down 再收走、准备阶段错误带原文；核心找包路径没有契约测试——加真 hypit 契约测试（含反向对照）；Agent 能读 `~/.codex/auth.json`——加入不许读的凭据。第二轮 2 MEDIUM：变体会话能写模板根的 node_modules、本地装包不拦——按项目根判断并拦装包命令；guard.ts 302 行——规则拆到 node-modules-rule.ts。第三轮只剩 LOW，提交前收了装包命令的其它写法）。另：转写前也按当前设置重写 profile、写包前 lstat 目标（文件链接用例本机无权限跳过）、runHypit 也查 --workspace。不用 `--package-root` 的理由见上「技术核实」，审查逐条核对 hypit 源码认可。变异自检 31 + 17 + 7 条（等价 1）全杀，工作区 md5 未变 |
| 11.3 | 设置页 Codex（web）：生成服务分区里 Codex 行（版本、登录状态、未过时写 `codex login`）、启用开关（体检不过禁用并写原因）、「试出一张图」（进行中、成功显示图与耗时、失败展开原文、再试）；CMP-008 Build 表 codex 那行显示张数 | REQ-011 界面、AC-033 前端 | ✅ 两轮 review→fix，第二轮两阶段 PASS（首轮 1 MEDIUM 规格：前端判「准备好」比后端严——只差 Provider 包没同步上时后端允许启用与试图（会当场重试同步），界面却全禁、修法还被当成命令——体检加 `ready` 字段按它放行；2 MEDIUM 质量：抽屉展开时这一行溢出、模型与状态列被挤成 0 宽（审查实测）——容器 <640px 改为换行排布；开始试图用默认 5 秒超时、服务端回 202 前要跑 codex --version 与 runtime down——单给 90 秒。另收：出错提示显示 JSON 包、Worker 没停掉不显示、开着时措辞、禁用原因只能悬停（改 aria-describedby）、设计稿差异写注释。第二轮只剩 LOW，提交前收了：模型列在抽屉展开 1575–1680 宽时只剩「gp…」（两列按比例分宽）、测试桩补 `ready`、开关后重拉体检）。开关组件照设计稿「生视频通道」行里的画法（28×16，token 取色）；行结构同那一行，名称列 150px（210px 在 1280 宽下把模型列挤没，真浏览器实测）。真浏览器：1280 / 1440 / 1600 / 1680 宽、抽屉开合都无裁切。变异自检 web 18 + 7 条（等价 1）全杀 |
| 11.4 | Phase 10 交接：压缩失败（`status` 带 `compact_result: failed`，SDK 不给 token 数）按这一段见过的最大读入上下文（含缓存读写）估一笔；⑤ 成片卡片与模板累计遇「未知（没填单价）」标「含未知」；拦截读凭据变量补 PowerShell `env:ANTH*` 通配与 Git Bash `/c/Users/...` 形式路径 | Phase 10 交接 | ✅ 十一轮 review→fix，第十一轮两阶段 PASS（第八轮 Stage 1 通过，Stage 2 的两个 MEDIUM——客户页表头没跟着行加宽、「前面有过调用时普通 status 不计价」没有用例——已修；按用户要求先提交推送；第九轮（提交后）Stage 1 通过，Stage 2 一个 MEDIUM（等待放宽到 3 秒后，估价事件那条用例会被 3 秒轮询盖住）已在后续提交修掉、变异「监听错事件名」被杀；第十轮 Stage 1 通过，Stage 2 一个同类 MEDIUM（④ 队列「推事件重拉」那条的夹具是会 3 秒轮询的排队中，estimate / build 监听坏了也可能照过）已修：夹具改成不轮询的待确认花费，丢任一监听的变异 4 次全杀；第十一轮确认两阶段 PASS，只剩 LOW（进交接），审查自己在独立拷贝里重跑三个监听变异各 4 次全杀、web 9 条变异全杀）。压缩失败计价与「含未知」三处第一轮就过了 Stage 1；反复不过的是凭据拦截：按命令文本匹配天生拦不全，每轮都有同一类的新写法（通配 / 管道 / 数组 / 括号 / 续行 / `Environment::` / 先 cd 再列，家目录的各种拼法、先进家目录再用相对路径、路径紧跟分隔符），也修出过误拦（grep / echo / heredoc 里的「env:」、`-type`）。第七轮后用户拍板：补完那一处就收，Spec 写明文本匹配是尽力拦截、同类新写法按低优先级进交接、彻底隔离（系统账户或沙箱）放后续 Phase。规则从 guard.ts 拆到 env-read.ts（guard.ts 到了 300 行）；客户页三列宽度表头与行共用一份常量。另收：Provider 测试收尾删目录偶发 EPERM（Windows 上同步 `rmSync` 遇 EPERM 不重试，改异步 `rm`，孤儿孙进程不再占用例目录）；仓库根门禁三个包并行跑测试时偶发超时（改为一个包一个包跑，testing-library 默认等待从 1 秒放宽到 3 秒）。变异自检 server 52 条、web 9 条全杀（独立拷贝，工作区 md5 未变） |
| 11.5 | Phase 11 真机验收与收口：隔离环境；AC-031 启用后出一条含 1 个 gpt-image 请求的片子（真实 Codex，贴子进程命令行、PNG 尺寸、build 里的图、台账 $0 与张数 1）；「试出一张图」成功一次；AC-032 假 codex（exit 0 不出图）真跑；AC-033 CODEX_HOME 指向空目录模拟未登录截图；全程开 CDP Network 事件，遇请求卡住就记下并定性；四步验证 | Phase 11 验收标准 | 🟡 AC-032、AC-033 真机通过；宿主成功路径用假 codex 走通；AC-031 与「试出一张图」被 Codex 订阅额度挡住，待 2026-09-27 08:09 后补验；请求卡住已定性（见「已知风险」）；四步验证见下「Phase 11 收口」 |

**验收标准**：
- AC-031、AC-032、AC-033 通过
- Provider 自带的生命周期测试不发真实请求即可跑过

**Phase 11 收口（11.5 真机，2026-09-25～26）**：
- 环境：数据根设为短路径临时目录（`%TEMP%/cs-acc11`，功能复核用 `%TEMP%/cs-acc11f`），后端 4413（工作区源码、非 watch）、vite 5174（scratch 里的独立配置，只读工作区 web 源码）、独立无头 Chrome 9333 + CDP，全程开 CDP Network 事件记进 network*.log。假 codex 是 npm 式垫片（`codex.cmd` → `node …/@openai/codex/bin/codex.js`）放在 PATH 最前，CODEX_HOME 指向 scratch 里只放了一个占位 `auth.json` 的目录。
- AC-033（通过）：CODEX_HOME 指向空临时目录：体检行 warn「codex-cli 0.153.4 · 未登录」、修法 `codex login`、`ready: false`；`PATCH /api/settings` 启用回 409 `CODEX_NOT_READY`，设置保持关闭；试图接口同样 409；设置页开关禁用，提示「没准备好，开关不能打开：执行 codex login 后点「重新检测」」。截图 ac033-settings.png、ac033-health.png。
- AC-032（通过）：假 codex `FAKE_CODEX_MODE=none`（exit 0、不出图）：估价行 gpt-image-2 → `codex.local` ×1、$0、自动放行；build 失败，原文「Codex 正常退出，但没有产出图片（./images 与 generated_images 都没有）。JSONL 末段：…」；假 codex 只被调 1 次，argv 与 REQ-011 参数数组逐项一致（`exec --ignore-user-config --json --ephemeral -c windows.sandbox="elevated" --sandbox workspace-write --skip-git-repo-check -C <临时目录> -- "$imagegen …仅生成图片；不要写入、复制或修改任何其它文件。"`），NODE_OPTIONS 为空；台账 codexImages 1、$0。截图 ac032-failure.png。
- 宿主成功路径（假 codex，补做，不等于 AC-031）：在 cb3bcbc 上用假 codex 出图模式（scratch 里那份假 codex 改成产出 1024×1536 的 PNG；仓库测试夹具是 1×1，渲染不成视频）：估价自动放行 $0 → build `bld_20260925T190402638Z_5897917F74` 41 秒完成 → build 里的图 `file-0001.png` 1024×1536，成片 h264 1024×1536、30 fps、3.0 秒（ffprobe）→ 台账 `costUsd 0`、`codexImages 1`。⑤ 卡片「复刻片 v1 · 0:03 · 完成 · $0.00 估 含未知」（临时库里补了一条没填单价的 Agent 任务），花费明细出片行「本机渲染 · Codex 生图 1 张 · $0.00 估」、合计下写「不含没填单价、算不出的 Agent 花费」，播放器视频 1024×1536、3.00 秒；设置页 Codex 行「✓ codex-cli 0.153.4 · 已登录」、开关打开；客户页三列表头与单元格右边线逐列对齐（886 / 1058 / 1166 px），「含未知」没被裁。截图 f115-*.png。
- AC-031（未通过，被额度挡住）：真实 Codex（npm 全局 0.153.4，真实 `~/.codex` 已登录，只查 auth.json 在不在）：估价同上自动放行 $0；出片时抓到的子进程命令行：`"C:\Program Files\nodejs\node.exe" …\npm\node_modules\@openai\codex\bin\codex.js exec --ignore-user-config --json --ephemeral -c "windows.sandbox=\"elevated\"" --sandbox workspace-write --skip-git-repo-check -C %TEMP%\cs-codex-PVuiXB -- "$imagegen …"` 与它起的 `codex.exe`（同一组参数）；约 20 秒后 build 失败，原文「Codex 报错：You've hit your usage limit. … try again at Sep 27th, 2026 8:09 AM.」；台账 codexImages 1、$0。PNG 尺寸、build 里的图拿不到。（抓到的命令行里提示词的中文是乱码，是 PowerShell 控制台代码页读出来时弄坏的；同一套参数经假 codex 记下的 argv 是正确的 UTF-8。）
- 「试出一张图」（未通过，同一原因）：设置页点一次，14 秒后失败，展开的原文同上额度报错（截图 try-real-quota.png）。
- 一次误起真实 Codex（功能复核时）：第一次起后端时 Git Bash 里 PATH 写成了 `C:/…/fakebin`，冒号把这一项拆成 `C` 和一个不存在的目录，假 codex 没进 PATH，宿主找到的是真实 codex。它用的是 scratch 里的占位 CODEX_HOME，刷新登录就失败了：没出图、没花额度，用户真实的 `~/.codex` 没碰；它在占位目录里写下的状态文件已删。之后起后端前先用宿主自己的 `resolveCodexCommand()` 在同一个环境里核对「解析到的是假 codex」，不是就不起。
- 真实 Codex：起了 3 次（AC-031 出片 1、试图 1、上面误起 1），出图 0 张（上限 4）；额度在第一次调用前就已经用完。真实 Agent 会话 0 条（$0）；没调用任何付费生成服务。
- 请求卡住（Phase 9、10 交接）定性，见「已知风险」。证据：network.log 里 `GET …/agent-job` 等满 5 秒被页面超时中止（ERR_ABORTED）、一次文档请求 25.8 秒才回，同一时刻 curl 直连后端与经 vite 代理都在 5 ms 内回来；stall 脚本每次 `Page.navigate` 到 about:blank 再回来，Chrome 网络进程到 5174 的已建立连接 3 → 6 → 9，挂着的都是旧页面的两条 `/api/events` SSE；离开页时 `pagehide` 的 `persisted` 为 true（旧页进了 bfcache），它的连接约 60 秒后才断；F5 重载 `persisted` 为 false、连接不涨。功能复核时又复现一次：花费明细请求在第二次进入页面时等满 5 秒，点「重试」即回。
- 收尾：后端（及其 tsx 父进程）、vite、无头 Chrome 按记下的 PID 停掉，4413 / 5174 / 9333 已释放；各验收工作区 `hypit runtime down`（Worker 均 stopped）；两个临时数据根删除前确认没有 junction；门禁中途失败留下的 `cs-*` / `clone-studio-*` 临时目录一并删掉（正常跑完不留）。
- 四步验证：
  1. Code Review：11.1～11.4 各自 code-reviewer 两阶段审查后单独提交（11.1 两轮、11.2 三轮、11.3 两轮、11.4 十一轮——第九～十一轮在用户要求先提交推送之后跑。第九轮结论：Stage 1 通过；Stage 2 一个 MEDIUM——web 默认等待放宽到 3 秒后，「估价事件让估价卡重拉」那条用例会被估价卡 3 秒一轮的轮询盖住，事件监听坏了也照过——已修：那条等待单写 1.5 秒、setup 注释写明这个代价，变异「监听错事件名」重新被杀。第十轮：Stage 1 通过；Stage 2 一个同类 MEDIUM（④ 队列「推事件重拉」那条的夹具是会轮询的排队中）已修，夹具改成待确认花费，丢 estimate / build / variants 监听的变异 4 次全杀。第十一轮（确认）：两阶段 PASS，只剩 LOW）。对照交付内容逐项落地：Provider 包（参数数组、清 NODE_OPTIONS、elevated 沙箱、`$imagegen` 恰好一次、结尾「仅生成图片…」、一图一进程、≤4 张参考图、10 分钟超时杀进程树、JSONL 单行 4 MB、两路找图、exit 0 且文件 >0、error 事件与额度原文、透明背景「不支持」、零价、不直连 chatgpt.com）、宿主（包同步进数据根、启用把关、runtime profile 写 endpoint 与 bindings、并发 1、体检 CLI ≥0.128 且 auth.json 在、试出一张图、台账记张数、覆盖包防护）、设置页（体检行、开关、试图）、Phase 10 交接四项。偏离：没加 `--package-root`（理由见「技术核实」，Spec 同步）。
  2. 测试完整性：goal 列的单测都有用例真走到——参数数组逐项、NODE_OPTIONS 被清、`$imagegen` 计数、两条找图路径各自兜底、exit 0 无图带 JSONL 末段、error 事件与额度原文、超时 kill、超长行、透明背景拒绝、零价与张数、未登录体检不过且开关不可开、bindings 与包同步；假 codex 驱动，Provider 生命周期测试不发真实请求；空态、错误态有用例。变异自检都在独立拷贝里跑、工作区 md5 未变：11.1 37 条、11.2 31 + 17 + 7 条（等价 1）、11.3 18 + 7 条（等价 1）、11.4 server 52 条 + web 9 条，除注明的等价变异外全杀。
  3. 编译：三个包 `tsc --noEmit` 0 错误（门禁里的 typecheck）。
  4. 功能：真机见上。仓库根 `pnpm run check`（测试改为逐包跑后）连续两次退出 0：prettier 通过；eslint 0 错误，2 条警告是既有文件的 fast-refresh 提示；providers 6 个文件 50 通过；server 90 个文件（1 跳过）972 通过、5 跳过；web 50 个文件 536 通过。

**给 Phase 12 的交接（Phase 11）**：
- AC-031 与「试出一张图」补验（2026-09-27 08:09 额度恢复后，共用 2 张，在 4 张上限内）：隔离环境照上面起（真实 codex、正常 PATH、不设 CODEX_HOME），`node flow.mjs ac031 <数据根>` 出一条含 1 个 gpt-image 请求的片子，贴子进程命令行、PNG 尺寸、build 里的图、台账 $0 与张数 1；设置页点一次「试出一张图」。脚本（flow.mjs、trytry.mjs、cdp.mjs、net.mjs）在本会话的临时目录 `%TEMP%/claude/X--workflow-clone-workflow/9a441a95-cd05-403f-a253-8d57353a4acd/scratchpad/acc11/`，随会话清理可能已经不在；不在就照上面的步骤重写（起隔离后端 → 启用 Codex → 建客户与模板 → 放一份含 1 个 gpt:Image 的 svml / svrun → 插一条复刻片 → 估价 → 盯 build 与 codex 子进程命令行）。
- 浏览器请求卡住的修法（见「已知风险」）：页面 `pagehide` 时关掉 EventSource、`pageshow`（persisted）时重连，或把两条 SSE 合成一条；用户同时开 3 个标签页也会撞上。
- 凭据拦截是尽力而为（Spec v1.10.6 写明）：同一类的其它拼写按低优先级补——11.4 各轮审查留下的有：`Get-Item env:\PATH` 这类读单个变量被当成整份导出误拦、缩进续行里 echo 的「env:」字样误拦、`RELATIVE_CONFIG` 的结尾没跟着放宽、kubectl jsonpath 里的 `.env` 误拦、`( set )`、`from os import environ`、`awk ENVIRON`、`npm run env`、`$env:HOME`、`CLAUDE_CONFIG_DIR` 下的通配、8.3 短名、单独的 `auth.json` 文件名误拦、引号包着的命令名。要彻底隔离得靠系统账户或沙箱，Phase 12/13 评估。
- 花费口径：没开跑就取消的任务也标「含未知」；每一段开跑时覆盖 cost_basis，前一段没单价、后一段有单价时「含未知」会消失；续跑一上来就压缩失败记 0（这一段还没见过调用）；压缩调用本身报错时照记一笔会多算；复刻片卡片与花费明细的「未知」口径不同（明细含共用会话）。
- 生产代码里 `removeTempDir`（providers/codex-image/src/provider.ts）、试图工程（server/src/services/codex-try.ts）、回收站（server/src/services/trash.ts）靠同步 `rmSync` 的重试，Windows 上遇 EPERM 其实不重试：provider 那处会留下空的 `cs-codex-*` 临时目录，试图那处会报「上一次的试图工程删不掉」——改成异步 `rm`。
- 11.1～11.3 留下的 LOW：试图与出片并发、Worker 退出时 codex 成孤儿、包同步的 TOCTOU 残余、非 Windows 的杀进程树、文件符号链接用例本机无权限跳过、设置页健康行的复制按钮在抽屉展开时溢出、状态文字在 1280 宽时被截断、出片失败原文前面带着 hypit 的命令 id（URL 编码的 `need:author…`）不好读。
- 门禁：三个包改为逐个跑、web 默认等待 3 秒后连续两次全绿；仍有少数用例对机器负载敏感（procs.test 固定等 800 ms 再查前置条件；output-delete* / variant-review-edge 在机器忙时会撞 server 统一的 20 秒用例上限），可能再抖。页面自己在轮询时（估价卡、复刻、⑤ 成片、④ 队列 3 秒一轮，出片卡 2 秒），证明「是事件触发」的用例要让夹具处在不轮询的状态，或把等待写得比轮询短（web/src/test/setup.ts 注释）。11.4 第十一轮留下的 LOW：这张轮询清单漏了设置页 Codex 行 5 秒一轮（CodexImage 的试图用例余量约 2 秒，暂不用改）；「等待比轮询短」是必要不充分——TanStack 每次数据更新都重启轮询计时，真正的条件是「距上次更新的时间 + 等待」短于轮询间隔，能用不轮询的夹具就用；④ 队列那条的待确认花费夹具没带 `needsMe` 与估价，和服务端真实返回不一致（不影响这条用例，可改用同文件里 confirm 那条的夹具）。
- 其它：`archive.ts` 298 行，再加就得拆；`price-meter.ts` 读入 token 的求和写了两遍；`HOME_CLAUDE` / `mentionsClaudeConfigDir` 这些名字和拒绝文案现在也管 `.codex`，该改名；几处测试里的 TemplateStats 桩没带 `costHasUnknown`。

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

- **Agent 写文件的越界检查不识别硬链接**（8.1 第三轮审查 L1）：PreToolUse 按真实路径判写入目标，工作目录里的硬链接指到外面时 Write / Edit 会写穿出去。
  junction / 符号链接都按真实路径拦了，硬链接的真实路径就是它自己。宿主这边凡是往 Agent 目录里写的都先删目录项再写（重跑复制原稿、替换素材图），不会替它写穿；Agent 自己写穿属于 REQ-003 已知的边界（Bash 写入路径本来就不全解析）。

- **Windows 路径长度（260）**：数据根太深时 hypit 在 `references/` 下 `mkdtemp` 会 ENAMETOOLONG（6.5 真机第一次用 scratchpad 深路径撞上，换到 `%TEMP%\cs-acc6` 即好）。默认数据根 `~/.clone-studio` 够短；设置页若允许改数据根，要提示或校验长度。

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
- **浏览器请求卡住（11.5 已定性）**：离开页面时旧页进了 Chrome 的前进后退缓存（bfcache，`pagehide` 的 `persisted` 为 true），它的两条 `/api/events` SSE（开发时再加一条 HMR）约 60 秒后才断；同一主机 HTTP/1.1 最多 6 条连接，缓存里两页加当前页就占满，新请求排队到页面 5 秒超时（Phase 9、10 的偶发卡住与 11.5 的两次复现都是这个）。F5 重载不会；用户同时开 3 个标签页也会撞上。对策（Phase 12）：`pagehide` 时关 EventSource、`pageshow`（persisted）时重连，或把 SSE 合成一条连接；生产由后端静态托管仍是同主机 HTTP/1.1，解决不了。
- 非 Claude 模型跑 hypit skill 成功率低 → Phase 10 只保证接得上与拦得住，不保证质量。

## 开发规则

- 每完成一个 Phase 执行四步走：Code Review → 测试完整性 → 编译验证 → 功能测试
- 四步走全部通过后才能 commit
- Commit message 用 feat、fix、refactor、chore 前缀
- 包管理器：pnpm
- 不修改 `hypit-main/`；UI 以设计稿为准，其次 Design-Brief
- 仓库就是项目根目录（分支 `feat/clone-studio`），`clone-studio/` 是其中一个子目录，**不要在它里面再 `git init`**。根 `.gitignore` 与 `clone-studio/.gitignore` 共同排除数据根目录、`secrets.json`、`app.db` 与构建产物
- 测试文件不进构建产物：`server/tsconfig.json` 的 `exclude` 含 `src/**/*.test.ts`，否则 `dist/` 里会多出一份 `*.test.js` 被 vitest 重复执行
