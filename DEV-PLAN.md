# Development Plan — Clone Studio

> 本文件记录项目的开发阶段划分、当前进度和剩余工作。
> 新 session 启动时应首先阅读此文件，了解项目状态后再继续开发。
>
> 依据：Product-Spec.md v1.2、Design-Brief.md v1.0、设计稿 https://claude.ai/artifact/7DWGBWDbka6Wm71vV6TBbH（7 屏，UI 以设计稿为准）、Hypit-Research.md、用户提供的《Codex 生图配置说明》（不随仓库分发，要点已写入 Spec REQ-011）。
> 代码目录：`clone-studio/`（pnpm workspace：`server/`、`web/`、`providers/`）。`hypit-main/` 只读，不得修改。

## 总体架构

- `server/`：Fastify 后端，只绑 127.0.0.1。三类长任务都由它独占调度：确定性 hypit CLI 子进程、Claude Agent SDK 会话、出片 build。状态机只在后端写，前端只读 + 发动作。实时数据走 SSE。
- `web/`：React SPA，开发期 Vite 代理到后端，生产期由后端静态托管。
- `providers/codex-image/`：项目自有的 Hypit Provider 包，经 `--package-root` 挂给 hypit。
- 数据根目录（默认 `%LOCALAPPDATA%\CloneStudio`）：`app.db`、`secrets.json`、`clients/<id>/templates/<id>/`（每个模板一个 Hypit 工程目录，变体在其 `productions/<id>/`）。

功能依赖：骨架与库 → hypit 调用层与体检 → 归档 → 导入 → Agent 运行器 → 复刻与估价闸门 → 出片与验货 → 变体与素材审核 → 成片库与台账 → 模型档案 → Codex 生图 → 可靠性收尾。Agent 运行器与花钱闸门是最大风险，排在前半段。

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
- `node hypit-main/bin/hypit.mjs doctor --json` 有输出；最小 Run 产出一个可播放 mp4
- spike-notes.md 对 Q-003、ASM-002、Codex 出图三项各有"成立 / 不成立 + 证据"

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
- 实现体检：Node、hypit 依赖、ffmpeg/ffprobe、uv、Chromium、WhisperX、Claude Code 登录、TokenDance key；每项给现状与修复命令；"一键准备"调 `hypit programs prepare` 并推进度
- 实现设置页（设计稿"设置"画板）：体检、TokenDance key 验证（`hypit doctor --endpoint tokendance.default`）、HypiHub 浏览器授权连接、限额与熔断、并发、路径；改完即存
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
- 生成的工程目录能被 `hypit doctor --workspace <dir> --json` 识别

---

## Phase 3: 客户 / 模板归档（REQ-001，FLOW-004）

**交付内容**：
- 实现客户与模板的创建、重命名、删除接口；删除级联库记录与磁盘目录，删除前中止关联任务
- 实现侧栏树（状态点、悬停"…"菜单、+ 新客户）、首页空状态、客户页模板紧凑列表
- 实现模板页框架：页头（模板名就地改、累计花费）+ 五步步骤条 CMP-001（锁定 / 可进入 / 当前 / 进行中 / 需处理 / 完成 / 失败）+ 步骤工作区路由；刷新保持当前模板与步骤

**关键文件**：
- `clone-studio/server/src/routes/clients.ts`、`server/src/routes/templates.ts`
- `clone-studio/server/src/services/deletion.ts` — 停任务 → 删目录 → 删库，失败整体回滚
- `clone-studio/web/src/pages/HomePage.tsx`、`web/src/pages/ClientPage.tsx`、`web/src/pages/template/TemplateLayout.tsx`
- `clone-studio/web/src/components/Stepper.tsx`（CMP-001）、`web/src/components/TaskRow.tsx`（CMP-002）

**验收标准**：
- AC-001、AC-003 通过；AC-002 在 Phase 5 任务可运行后补验
- 同名、超长名在输入框下红字提示

---

## Phase 4: 参考视频导入与证据准备（REQ-002，设计稿"① 参考"）

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
- 实现运行器：Agent SDK `query()`，cwd = 工程目录，预置 `.claude/skills/hypit`（从 `hypit-main/skills/hypit` 复制），完整工具集，系统提示注入"出片由宿主负责"与当前可用生成能力清单
- 实现 `canUseTool` 两条硬拦截：任何 `hypit build` / `hypit result` 写操作；写入路径不在工程目录前缀内
- 实现熔断：45 分钟墙钟、$5 等价花费（按 Phase 0 结论取 SDK 值或档案单价折算）、同命令连续失败 5 次、10 分钟无消息；订阅限流进"等待额度"并到点自动 resume
- 实现调度器：Agent 并发上限（默认 2）、排队、取消、中止、继续（resume）、重跑（清 Agent 产物）
- 消息全量落 `agent_messages`，SSE 推送，刷新后补发历史
- 实现右侧抽屉：顶栏（状态、模型、用时、花费 / 上限、中止）、待办清单、markdown 逐字流式、工具调用折叠行、长输出折叠、错误红竖线、拦截琥珀竖线、结束卡
- 实现熔断 / 中断横条 CMP-009

**关键文件**：
- `clone-studio/server/src/agent/runner.ts` — SDK 会话生命周期
- `clone-studio/server/src/agent/guard.ts` — canUseTool 拦截规则
- `clone-studio/server/src/agent/breaker.ts` — 熔断与卡死检测
- `clone-studio/server/src/agent/prompts.ts` — 复刻 / 变体 / 打回的系统提示与任务提示
- `clone-studio/server/src/agent/scheduler.ts`、`server/src/routes/agent-jobs.ts`
- `clone-studio/web/src/components/agent/AgentDrawer.tsx`、`agent/MessageStream.tsx`、`agent/ToolRow.tsx`、`agent/TodoList.tsx`
- `clone-studio/web/src/components/BreakerBar.tsx`（CMP-009）

**验收标准**：
- AC-007、AC-008、AC-009、AC-010、AC-002 通过
- `guard.ts` 有单元测试覆盖：`hypit build`、`node …/hypit.mjs build`、PowerShell 与 bash 两种写法、越界写路径

---

## Phase 6: 复刻、估价闸门与出片（REQ-004 前半、REQ-006、REQ-009，设计稿"② 复刻"）

**交付内容**：
- 导入完成后自动启动复刻任务；完成判据：`reference.svrun` 存在、`hypit check --json` 通过、`ANALYSIS.md` 与 `TIMELINE.md` 存在
- 实现 ②复刻 页面：分析摘要、时间线（点时间码联动参考播放器）、校验结果三个折叠区，随文件产生逐个出现
- 实现花钱闸门：`plan --json` + `pricing --json` → 估价与请求明细；单条限额与批次限额判定；拿不到估价一律按超限；plan 有未解析请求则失败并指明缺哪种能力
- 实现出片执行器：`build --follow --json` + `activity --watch --jsonl` 取结构化进度，渲染并发上限（默认 1），`get` 导出到 `output/`，key 只注入 hypit 子进程环境
- 实现估价 / 限额卡 CMP-006、出片进度 CMP-007、台账写入（`builds`、AgentJob 花费）

**关键文件**：
- `clone-studio/server/src/services/clone.ts` — 复刻编排与完成判据
- `clone-studio/server/src/services/gate.ts` — 估价与限额判定（纯函数 + 单元测试）
- `clone-studio/server/src/services/build.ts` — build、进度、导出、取消
- `clone-studio/server/src/services/ledger.ts` — 花费记账
- `clone-studio/web/src/pages/template/CloneStep.tsx`、`web/src/components/EstimateCard.tsx`、`web/src/components/BuildProgress.tsx`

**验收标准**：
- 一条真实参考视频走到复刻完成，三个区块与估价卡出现
- AC-017、AC-018 的判定逻辑由 `gate.ts` 单元测试覆盖；AC-020 用 Phase 0 的无生成模型 Run 实测通过

---

## Phase 7: 模板验货（REQ-004 后半，设计稿"③ 验货"）

**交付内容**：
- 复刻片作为 `productions`（kind=replica，带 version）入库
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

## Phase 12: 可靠性收尾与端到端验收

**交付内容**：
- 崩溃恢复全链路复测：杀后端、断电式重启后任务标"中断"可继续，无孤儿子进程
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
| `model_profiles` | Phase 10 | Agent 模型档案（token 存 secrets.json，不入库） |

## 已知风险

- 订阅登录下 SDK 花费字段与限流行为未知 → Phase 0 验证二先行；不成立则 $ 熔断退化为时间与卡死检测，并回写 Spec。
- `hypit pricing` 对 TokenDance 的估价可用性未知 → Phase 0 验证一；拿不到则全部人工确认。
- TokenDance 无 TTS，Seedance 拒绝真人脸参考 → 复刻系统提示里写明可用能力；缺能力时 plan 失败并指明。
- tsx 冷启动使每次 hypit 调用多数秒 → 证据流水线串行可接受；出片前的 check / plan / pricing 合并展示一次等待。
- 非 Claude 模型跑 hypit skill 成功率低 → Phase 10 只保证接得上与拦得住，不保证质量。

## 开发规则

- 每完成一个 Phase 执行四步走：Code Review → 测试完整性 → 编译验证 → 功能测试
- 四步走全部通过后才能 commit
- Commit message 用 feat、fix、refactor、chore 前缀
- 包管理器：pnpm
- 不修改 `hypit-main/`；UI 以设计稿为准，其次 Design-Brief
- 项目根目录当前不是 git 仓库：Phase 1 开工时在 `clone-studio/` 内 `git init`，`.gitignore` 排除数据根目录与 `secrets.json`
