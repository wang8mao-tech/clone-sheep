# 产品需求规范：Clone Studio（暂定名）

> 版本 v1.6 · 2026-09-20 · 内核：Hypit 0.2.6（本地副本 `hypit-main/`）· 技术调研见 `Hypit-Research.md`
> Phase 0 先行验证结论见 `clone-studio/docs/spike-notes.md`，本版据其回写。

## 0. AI 使用说明

- 本文档是产品功能、范围、行为和验收标准的事实来源。
- AI MUST 优先实现 P0。
- AI MUST NOT 实现"不在本版本范围"中明确排除的内容。
- AI MUST 根据"验收标准"判断功能是否完成。
- 如果信息不明确，AI MUST 使用"假设"中的假设；如果仍无法判断，应记录到"待确认问题"，而不是自行扩展需求。
- AI MUST NOT 修改 `hypit-main/` 内任何文件。Hypit 是被驱动的内核，只通过 CLI 子进程和它的 skill 使用。

---

## 1. 产品上下文

### 1.1 产品摘要

Clone Studio 是一个跑在本机的 Web 应用，给 Hypit 套一层前后端：用户丢进一条参考视频，后端无头驱动 Claude Agent 把它复刻成 Hypit workflow（SVML 模板），验货通过后，用户一次写 N 句变体描述，系统排队批量产出 N 条同结构、不同内容的成片。

### 1.2 用户问题

Hypit 只能在 Coding Agent 终端会话里用：一次一条、全程盯着终端、没有归档、没有成本闸门、没有批量。工作室替客户做排行榜/混剪/解说类短视频，要的是"一份模板出 N 条"，现状是每条都要人守着一个终端会话手工推进，产物散落在各个目录里，花了多少钱也不知道。

### 1.3 目标用户

| 用户类型 | 描述 | 核心需求 |
|---|---|---|
| 工作室操作员 | 替客户批量制作排行榜/混剪/解说类短视频的小团队成员，本机操作，客户只拿成片 | 把一条爆款参考视频变成可复用模板，再批量换主题出片，全程不碰终端 |

明确不为谁做：外部注册用户、客户本人、无 Claude 订阅的人。

### 1.4 核心价值

一条参考视频 → 一个验过货的模板 → 一句话一条变体，无人值守批量出片，每一分钱花在哪有账。

### 1.5 成功标准

| 判断标准 | 目标 / 信号 |
|---|---|
| 北极星：单模板产出的合格成片数 | 一个验货通过的模板，一次批量提交 ≥5 条变体，≥80% 无需人工进终端干预即产出可下载 mp4 |
| 人工占用 | 从提交批量到全部出片，人只在"素材审核"和"超限额确认"两处介入 |
| 成本可见 | 每条成片的生成模型花费和 Agent 等价 token 花费在界面上可查，误差以 Hypit/SDK 报告值为准 |

---

## 2. 范围

### 2.1 本版本范围

| 编号 | 内容 | 优先级 | 备注 |
|---|---|---|---|
| SCOPE-001 | 客户 → 模板 → 成片 三级归档，含创建、重命名、删除 | P0 | 删除级联 |
| SCOPE-002 | 参考视频导入：上传本地文件或粘贴链接 | P0 | 链接走 `hypit media fetch` |
| SCOPE-003 | 复刻：无头 Claude Agent + hypit skill 产出 SVML 模板及分析文档 | P0 | |
| SCOPE-004 | 模板验货：按原样出一条复刻片，与原片并排对比，通过/打回 | P0 | 通过才解锁变体与成片 |
| SCOPE-005 | 批量变体：多行 brief 一次提交，排队由 Agent 逐条写变体 SVML | P0 | |
| SCOPE-006 | 素材审核闸门：Agent 联网搜来的条目图出片前人工过目，可替换单张 | P0 | |
| SCOPE-007 | 花钱闸门：出片前 plan/pricing 估价，单条与批次限额内自动放行，超限等人确认 | P0 | 默认单条 $1.5、批次 $15 |
| SCOPE-008 | 渲染出片、进度、预览播放、下载 mp4 | P0 | |
| SCOPE-009 | Agent 过程日志抽屉（流式）、熔断、继续/重跑 | P0 | 45 分钟或 $5 先到先停 |
| SCOPE-010 | 设置页：环境体检、生成服务凭据（TokenDance 为主，HypiHub 可选）、限额、并发 | P0 | |
| SCOPE-011 | 花费台账：每条成片与每个 Agent 任务的花费记录 | P0 | 嵌在成片/任务详情里，不做独立报表页 |
| SCOPE-012 | 对话式精修：和 Agent 对话改某条成片的 SVML 并重出 | P1 | 二期；v1 只留"打回意见"这种单向输入 |
| SCOPE-015 | 生视频通道切换：TokenDance、MiniMax H3 云端直连、MiniMax H3 本地 ComfyUI、即梦会员 CLI（Seedance）四个通道可选；模板验货时可换通道重出复刻片对比版本，选定为模板默认，变体沿用，单条可换通道重出 | 机制 + TokenDance + MiniMax 云端为 P0；ComfyUI 与即梦 CLI 为 P1 | 不做并排多模型同出；见 REQ-012 |
| SCOPE-014 | Codex 订阅生图 Provider：自写一个 Hypit Provider 包，经本机 Codex CLI 的 `$imagegen`（gpt-image-2）用订阅额度出图，替代按量付费的生图接口 | P1 | 见 REQ-011 |
| SCOPE-013 | Agent 模型切换：设置页维护"模型档案"，默认本机 Claude Code 订阅，可切到 DeepSeek / 豆包 / Gemini / ChatGPT 等经 Anthropic 兼容端点接入的模型 | P0 | 只认 API key，不认这几家的聊天订阅；见 REQ-010 |

### 2.2 不在本版本范围

| 编号 | 内容 | 原因 |
|---|---|---|
| OUT-001 | 账号、登录、多租户、计费 | 单机自用；对外 SaaS 需 Hypit 商业授权和 Agent 沙箱 |
| OUT-002 | 部署到服务器、远程访问、Electron 打包 | v1 只跑 localhost |
| OUT-003 | 网页内时间轴/SVML 可视化编辑器 | Hypit Studio 写接口限 localhost 同源，重写一层 UI 工期过大 |
| OUT-004 | 客户门户、成片分享链接、审片批注 | 客户只拿成片文件 |
| OUT-005 | HiAPI / Pollo / Monid 等未列入 REQ-011、REQ-012 的生成 Provider 配置界面 | 用户实际在用的通道已覆盖 |
| OUT-008 | 同一镜头多模型同时出片并排对比、逐镜头选优 | 用户明确只要能切换；对比靠验货页的复刻片版本切换 |
| OUT-006 | 自动发布到抖音/TikTok/YouTube 等平台 | 与复刻出片无关 |
| OUT-007 | 独立的花费统计报表、导出账单 | 台账够用，报表是运营需求 |

---

## 3. 用户任务

| 编号 | 用户任务 | 用户类型 | 优先级 |
|---|---|---|---|
| TASK-001 | 按客户归档和找回模板与成片 | 操作员 | P0 |
| TASK-002 | 把一条参考视频变成可信的可复用模板 | 操作员 | P0 |
| TASK-003 | 用一个模板批量产出不同主题的成片 | 操作员 | P0 |
| TASK-004 | 控制并看清每条片花了多少钱 | 操作员 | P0 |
| TASK-005 | 拿到成片文件交付客户 | 操作员 | P0 |
| TASK-006 | 让本机环境和凭据就绪 | 操作员 | P0 |
| TASK-007 | 对不满意的成片反复微调 | 操作员 | P1 |

---

## 4. 用户流程

### FLOW-001: 首次环境就绪

**关联任务：** TASK-006　**优先级：** P0　**目标：** 让所有依赖可用，否则后面每一步都会神秘失败。

**入口：** 首次打开应用，或任一体检项不通过时自动跳设置页。

**主路径：**
1. 应用启动后端跑体检：Node 版本、`hypit-main` 依赖已安装、ffmpeg/ffprobe、uv、Chromium、WhisperX 本地服务、Claude Code 登录态、生成服务凭据（TokenDance key 为主，HypiHub 可选）。
2. 设置页逐项显示 通过/未通过 + 修复指引（可复制的命令）。
3. 用户填 TokenDance API key（可选再连 HypiHub），点"验证"，后端用 `hypit doctor --endpoint <instance> --json` 确认。
4. 全部 P0 项通过，顶部横幅消失，可新建客户。

**分支路径：**
- 无任何已验证的生成服务凭据：允许进入，但复刻片验货和出片按钮禁用并提示原因；导入和 Agent 复刻（不花生成模型钱）仍可用。

**边界情况：**
- Claude 未登录：提示在终端执行 `claude` 完成登录，附"重新检测"按钮。
- Chromium/Python 环境未预热：提供"一键准备"按钮调 `hypit programs prepare`，显示下载进度。

**完成状态：** 设置页体检全绿，侧栏可用。

### FLOW-002: 参考视频 → 验货通过的模板

**关联任务：** TASK-002　**优先级：** P0

**入口：** 客户下点"新建模板"。

**主路径：**
1. ①参考：填模板名，上传 mp4 或贴链接，选视频语言，可选填"复刻备注"。提交。
2. 后端建模板工作目录，确定性跑：fetch（若为链接）→ probe → transcribe → 抽帧拼图。步骤条显示每个子步骤。
3. ②复刻：自动启动复刻 Agent 任务。右侧抽屉流式显示 Agent 过程。Agent 产出 `ANALYSIS.md`、`TIMELINE.md`、`reference.svml/.svs/.svrun`，并通过 `hypit check`。
4. 工作区显示分析摘要、时间线、check 结果。后端跑 plan/pricing 得到复刻片估价。
5. ③验货：估价 ≤ 单条限额则自动开始出复刻片，否则等用户点"确认出片"。渲染进度显示。
6. 出片后左右并排播放器：左原片、右复刻片，同步播放/暂停/拖动。
7. 用户点"通过"。模板状态变"已验货"，解锁 ④变体。

**分支路径：**
- 用户点"打回"并写意见 → 意见作为新消息 resume 同一 Agent 会话 → 回到步骤 3。
- Agent 熔断（超时/超预算/卡死）→ 任务状态"已熔断"，保留中间产物，提供"继续"（resume）和"重跑"（清空 Agent 产物重新来）。

**边界情况：**
- 链接下载失败、视频无音轨、时长超过 180 秒：在①给出明确错误，不进入②。
- 订阅限流：Agent 任务进"等待额度"态，按 SDK 返回的重置时间自动续跑，不算熔断。
- check 反复不过：计入卡死检测。

**完成状态：** 模板标记"已验货"，复刻片作为该模板下第一条成片入库。

### FLOW-003: 批量变体 → 成片

**关联任务：** TASK-003、TASK-004、TASK-005　**优先级：** P0

**入口：** 已验货模板的 ④变体 步骤。

**主路径：**
1. 多行文本框，一行一条 brief（例："换成 2026 年手机品牌排行，毒舌风格，普通话"）。可选：批次公共备注、目标语言。提交前显示条数和批次限额。
2. 每行生成一条变体记录进队列，状态"排队"。按并发设置逐条启动变体 Agent 任务。
3. Agent 以模板 SVML 为基础写 `variant.svml/.svrun`，联网搜条目图存入 `assets/`，写 `SOURCES.json`（每张图的来源 URL），通过 check。状态转"素材待审"。
4. 用户打开该变体：缩略图网格 + 来源链接 + 台词全文。可对单张"替换"（上传本地图）。点"素材通过"。
5. 后端跑 plan/pricing。估价 ≤ 单条限额且批次累计未超 → 自动出片；否则状态"待确认花费"，显示估价明细，等用户点确认。
6. 渲染，进度条。完成后 `hypit get` 导出 mp4 入库，状态"完成"。
7. ⑤成片：列表里点开播放、下载；支持多选批量下载（zip）。

**分支路径：**
- 素材不行 → "打回"写意见 → resume 该变体 Agent 会话重新找图/改稿。
- 出片失败 → 状态"失败"，显示 Hypit 错误 code 与 message，提供"重试出片"（不重跑 Agent）和"重跑"。
- 用户取消排队中/进行中的变体 → Agent 中止或 `hypit cancel`，状态"已取消"。

**边界情况：**
- 空行忽略；单行 >500 字拒绝；一次 >20 条拒绝。
- 批次累计花费达到批次限额：剩余变体全部停在"待确认花费"，不自动放行。
- 应用或机器中途崩溃：重启后"进行中"的任务标为"中断"，可继续。

**完成状态：** 批次每条变体都处于 完成/失败/已取消 之一，完成的可播放下载，花费已记账。

### FLOW-004: 归档管理

**关联任务：** TASK-001　**优先级：** P0

**主路径：** 左侧栏客户列表 → 展开见模板 → 点模板进流水线页。客户、模板、成片均可重命名和删除。

**边界情况：** 删除有进行中任务的对象时，先提示"将中止 N 个任务"，确认后中止再删。删除连带删磁盘工作目录，不可恢复，二次确认需输入名称。

---

## 5. 功能需求

### REQ-001: 客户/模板/成片归档

**优先级：** P0　**关联任务：** TASK-001　**关联流程：** FLOW-004

**行为：** 左侧栏树形：客户 → 模板。模板页内 ⑤成片 列出复刻片与全部变体成片。

**规则：**
- MUST 任何可创建的对象都有删除路径：客户、模板、变体/成片、上传的替换图。
- MUST 删除级联：客户→其全部模板→其全部成片与工作目录。
- MUST 删除前中止关联的运行中任务。
- SHOULD 侧栏每个模板显示状态点：复刻中/待验货/已验货/有失败。
- MUST 进入模板页时默认落在**需要人动手的那一步**，优先级：需处理（如待验货）＞ 进行中 ＞ 失败 ＞ 能进入的最后一步。目的是打开就知道该干什么，而不是从 ①参考 一路点过去找。
- MUST 当前步骤写进地址，刷新停在原处；地址里指定的步骤只要已解锁就照它走，不被默认规则覆盖。
- MUST 地址里指定了未解锁或不存在的步骤时，送回按上面规则算出的那一步，不给空白页。

**输入：**

| 字段 | 类型 | 必填 | 校验规则 |
|---|---|---:|---|
| 客户名 | string | Yes | 1-40 字，同级不重名，去首尾空格 |
| 模板名 | string | Yes | 1-60 字，同客户下不重名 |

**状态：**
- 空状态：无客户时主区显示"先建一个客户"按钮；客户下无模板显示"新建模板"。
- 加载：侧栏骨架屏，>5 秒显示"后端未响应"与重试。
- 错误：重名/超长在输入框下红字；删除失败 toast 显示原因，对象保留。
- 成功：新建后自动选中。
- 无权限：不适用（单机无账号）。

**验收标准：**
- [ ] AC-001: Given 客户 A 下有 2 个模板共 5 条成片, when 删除客户 A 并输入名称确认, then 侧栏无 A，磁盘上 A 的目录不存在，数据库无其记录。
- [ ] AC-002: Given 模板有运行中 Agent 任务, when 删除该模板, then 弹窗提示将中止 1 个任务，确认后 Agent 进程已结束再删目录。
- [ ] AC-003: Given 同客户下已有模板"足球榜", when 再建同名, then 输入框下提示"名称已存在"，不创建。

### REQ-002: 参考视频导入与证据准备

**优先级：** P0　**关联任务：** TASK-002　**关联流程：** FLOW-002

**行为：** 接收文件或链接，存为 `references/src/source.mp4`，依次 spawn `hypit media probe`、`hypit transcribe`、`hypit media tiles`（均带 `--json`、`--workspace`），结果落模板工作目录。

**规则：**
- MUST 每个模板一个独立工作目录，含最小 `package.json` 与 `hypit.runtime.json`，所有 hypit 调用显式 `--workspace`。
- MUST 用 `node <hypit-main>/bin/hypit.mjs` 调用，不用根目录的 sh 脚本。
- MUST 转写走本地 WhisperX（`provider-whisperx-local`）。
- MUST 失败时展示 `hypit.cli-error@1` 的 code 与 message，不吞错。

**输入：**

| 字段 | 类型 | 必填 | 校验规则 |
|---|---|---:|---|
| 视频文件 | file | 二选一 | mp4/mov/webm，≤500 MB，时长 3-180 秒（probe 后校验） |
| 视频链接 | url | 二选一 | http/https，yt-dlp 可解析；失败提示改为上传 |
| 语言 | enum | Yes | zh/en/ja/ko/es 等 WhisperX 支持项，默认 zh |
| 复刻备注 | text | No | ≤1000 字 |

**状态：**
- 加载：子步骤清单逐项打勾（下载/探测/转写/抽帧），每项显示耗时；单项 >10 分钟标超时可重试。
- 错误：哪一步失败停在哪一步，显示错误与"重试此步"。
- 成功：自动进入复刻。

**验收标准：**
- [ ] AC-004: Given 一条 30 秒带人声 mp4, when 提交, then 工作目录下出现 source.mp4、transcript.json（含词级时间）与至少 1 张拼图，界面四个子步骤全勾。
- [ ] AC-005: Given 一条 200 秒视频, when 提交, then 探测后提示"时长超过 180 秒"，不启动 Agent。
- [ ] AC-006: Given 无效链接, when 提交, then 下载步骤标红并显示 Hypit 返回的错误信息，可改为上传文件后重试。

### REQ-003: Agent 任务运行器（复刻与变体共用）

**优先级：** P0　**关联任务：** TASK-002、TASK-003　**关联流程：** FLOW-002、FLOW-003

**用途：** 复刻和写变体是同一种东西：在某个工作目录里无头跑一个带 hypit skill 的 Claude Agent 会话。

**行为：** 后端用 Claude Agent SDK（TypeScript）`query()` 启动会话，cwd = 工作目录，工作目录的 `.claude/skills/hypit` 指向 `hypit-main/skills/hypit` 的副本。流式消息落库并经 SSE 推到前端抽屉。保存 session id 供 resume。

**规则：**
- MUST 传 `settingSources: []` 做会话隔离。实测不传会连用户本机 `~/.claude` 的权限规则与 hooks 一起继承（消息流里出现 `system:hook_started`），行为不可复现。
- MUST 给 Agent 完整能力：Bash、文件读写、联网搜索与抓取，等同终端里的 Claude Code。
- MUST 拦截花钱动作：主拦截手段是 `disallowedTools`，**任何禁用清单必须把 `Task` 一并禁掉**——实测只禁 `Bash` 时模型会派 Task 子 Agent 绕开并照样执行命令。`canUseTool` 只作补充：默认配置下它根本不会被调用（`sandbox.autoAllowBashIfSandboxed` 默认 `true`，沙箱内 Bash 自动放行）。系统提示里说明"出片由宿主负责，你写到 check 通过为止"。
- MUST 拦截记录由宿主自己写，不读 SDK 的 `permission_denials`：用 `disallowedTools` 隐藏工具时该字段恒为空数组。
- MUST 熔断：墙钟 45 分钟或等价花费 $5 先到先停；花费熔断用 SDK 的 `maxBudgetUsd` 选项 + `error_max_budget_usd` 结果子类型，不自己累加。设置页可改。
- MUST 读 `total_cost_usd` 时只取最新一条 `result` 消息，不跨 result 累加——resume 的会话会续上转录里保存的累计值（实测 resume 组 0.0518 > 被 resume 组 0.0479）。
- MUST 卡死检测：同一条命令连续失败 5 次，或 10 分钟无任何新消息 → 停并标"已熔断"。
- MUST 订阅限流不算失败：进"等待额度"，到重置时间自动 resume。
- MUST Agent 过程回显只进右侧抽屉，不进工作区主内容。
- MUST 渲染等重处理只由"出片"动作触发，不由 Agent 对话触发。
- SHOULD 抽屉按 Claude Code 习惯呈现：markdown 渲染、逐字流式、工具调用折叠显示、可"中止"。

**状态：** 排队 / 运行中 / 等待额度 / 已熔断 / 中断 / 完成 / 已取消。

**验收标准：**
- [ ] AC-007: Given 运行中的 Agent 尝试执行 `hypit build`, when 该工具调用被宿主的 `disallowedTools`（含 `Task`）挡下, then 命令未执行，宿主自己的日志里有一条"已拦截"记录，生成模型花费为 0。
- [ ] AC-008: Given 熔断预算设为 $0.2, when 复刻任务花费超过它, then 任务停在"已熔断"，中间文件保留，"继续"按钮可 resume 同一会话。
- [ ] AC-009: Given Agent 运行中, when 刷新浏览器, then 抽屉恢复历史消息并继续流式接收。
- [ ] AC-010: Given 后端进程被杀后重启, when 打开该模板, then 任务显示"中断"并可"继续"。

### REQ-004: 复刻产物与模板验货

**优先级：** P0　**关联任务：** TASK-002　**关联流程：** FLOW-002

**行为：** 复刻 Agent 完成判据：`reference.svrun` 存在且 `hypit check --json` 通过，`ANALYSIS.md`、`TIMELINE.md` 存在。之后走 REQ-006 估价闸门出复刻片，进并排对比。

**规则：**
- MUST 未"通过"验货的模板，④变体 与 ⑤成片 两步均锁定并说明原因。验货是质量闸门，没过之前不产出可交付的东西——复刻片在 ③验货 的并排播放器里看得到，不需要靠 ⑤成片 去看。
- MUST "通过"验货这一个动作同时解锁 ④变体 与 ⑤成片，复刻片此时作为该模板下第一条成片入库（与 FLOW-002 完成状态一致）。
- MUST 并排播放器两路同步：播放、暂停、拖动、倍速一致；默认只开原片声音，可切换。
- MUST 打回意见 1-2000 字，resume 原会话，保留历次复刻片版本供对比。
- SHOULD 显示两片的时长差与分辨率差。

**验收标准：**
- [ ] AC-011: Given 复刻片已出, when 拖动任一播放器进度条, then 另一路同步到同一时间点（误差 ≤0.2 秒）。
- [ ] AC-012: Given 模板未验货, when 点 ④变体, then 显示"先通过验货"且不可输入。
- [ ] AC-013: Given 用户打回并写意见, when Agent 再次完成并出片, then ③验货 出现版本切换，v1、v2 均可播放。
- [ ] AC-040: Given 模板未验货且复刻片已出, when 查看步骤条, then ④变体 与 ⑤成片 均为未解锁且不可点；when 点"通过", then 两步同时变为可进入。

### REQ-005: 批量变体与素材审核

**优先级：** P0　**关联任务：** TASK-003　**关联流程：** FLOW-003

**行为：** 每条 brief 复制模板源文件到 `productions/<variant-id>/`，启动变体 Agent（REQ-003）。Agent 改台词、榜单条目、配图提示词，联网搜真实可识别的条目图并裁切统一。完成后进素材审核。

**规则：**
- MUST 每张联网获取的图在 `SOURCES.json` 记录来源页 URL；无来源的图在审核界面标黄。
- MUST 素材未通过不得出片。
- MUST 替换单张图时保持文件名与尺寸规范，不需要重跑 Agent。
- MUST 并发上限可配，默认同时 2 个 Agent 任务、1 个渲染任务。
- SHOULD 审核界面同时展示变体台词全文，便于一眼判断主题是否跑偏。

**输入：**

| 字段 | 类型 | 必填 | 校验规则 |
|---|---|---:|---|
| briefs | text 多行 | Yes | 每行 5-500 字，空行忽略，1-20 条 |
| 目标语言 | enum | No | 默认同模板 |
| 批次备注 | text | No | ≤1000 字，附加给每条变体 |
| 替换图 | file | No | jpg/png/webp，≤20 MB |

**状态：** 排队 / Agent 写稿 / 素材待审 / 待确认花费 / 渲染中 / 完成 / 失败 / 已取消。
- 空状态：无变体时显示示例 brief 三条，点击填入。
- 错误：失败卡片显示阶段、错误 code、可选动作。

**验收标准：**
- [ ] AC-014: Given 已验货模板, when 提交 5 行 brief, then 出现 5 条变体，同时处于"Agent 写稿"的不超过 2 条。
- [ ] AC-015: Given 变体处于"素材待审", when 替换第 3 张图并点通过, then 出片使用新图，无新的 Agent 花费。
- [ ] AC-016: Given 提交 21 行, when 点提交, then 提示"一次最多 20 条"，不创建任何变体。

### REQ-006: 花钱闸门与出片

**优先级：** P0　**关联任务：** TASK-004、TASK-005　**关联流程：** FLOW-002、FLOW-003

**行为：** 出片前 spawn `hypit plan --json` 与 `hypit pricing --json` 得到外部请求数与执行参数。通过闸门后 spawn `hypit build <run> --follow --json`，并行 `hypit activity --watch --jsonl` 取结构化进度。完成后 `hypit get <build-id> --output final.video --to output/<name>.mp4 --json`。

**估价来源（Q-003 已解答，hypit 不出数）：** hypit 的 `pricing.kind` 只有 `"page"`（一个价格页 URL）和 `"local"`（零价）两种，不含任何结构化费率，官方文档明言 "Hypit itself calculates no total"。因此：
- MUST Clone Studio 自己维护一张"能力/模型 → 单价"费率表（随设置页可编辑），用 `plan --json` 的 `needs[].summary.fields`（宽高、`startFrame`/`endFrameExclusive`、帧率、采样率）与 `providerRequestCount` 自行计算估价。
- MUST 闸门界面同时展示 `providers[].pricing.url` 价格页链接，供人工核对费率表是否过期。
- MUST 费率表缺该能力的单价 → 按"估价拿不到"处理。

**规则：**
- MUST 估价 ≤ 单条限额 且 批次已花+估价 ≤ 批次限额 → 自动放行；否则停在"待确认花费"显示明细，人点确认才 build。
- MUST 估价拿不到（plan 失败、Provider 无价目、或费率表缺项）→ 一律按超限处理，等人确认。
- MUST plan 有未解析请求或 preflight 失败 → 不出片，标失败并展示原因。
- MUST 凭据用 `@hypit/credential-store-env`，TokenDance / HypiHub key 由后端注入 hypit 子进程环境变量，不写进工作目录任何文件。
- MUST 后端生成的 `hypit.runtime.json` 按已验证的生成服务写 endpoints：TokenDance（`@hypit/provider-tokendance`，覆盖 Seedance 2.0/2.5 视频、Seedream 5.0 lite 生图、MiniMax H3 视频）为主；HypiHub 已连接时一并写入，覆盖 TokenDance 没有的能力（配音 TTS、GPT Image 等）。
- MUST 把当前可用的能力清单（哪些模型能用、哪些不能）写进 Agent 系统提示，要求 Agent 只用可用能力写 SVML；plan 出现无 Provider 可解析的请求时标失败并指明缺哪种能力。
- MUST 渲染并发受 `hyperframes.local` 的 `workers` 与全局渲染任务数限制，默认 workers=4。
- MUST 记录花费到台账。**build 的实际花费拿不到**：hypit 的 Result 只有不含金额的 `receipt: { id, url? }`，全仓库无任何金额字段。故生成侧花费一律按"请求数 × 自维护单价"记账并标"估"，不谎称账单。

**输入（设置）：**

| 字段 | 类型 | 必填 | 校验规则 |
|---|---|---:|---|
| 单条限额 USD | number | Yes | 0-100，默认 1.5 |
| 批次限额 USD | number | Yes | ≥单条限额，≤1000，默认 15 |

**验收标准：**
- [ ] AC-017: Given 单条限额 $1.5, when 某变体估价 $0.9 且批次未超, then 素材通过后无需点击自动进入"渲染中"。
- [ ] AC-018: Given 估价 $2.1, when 素材通过, then 停在"待确认花费"，显示请求明细与估价；点确认后才开始 build。
- [ ] AC-019: Given 批次已花 $14.5、限额 $15, when 下一条估价 $0.9, then 该条及之后全部停在"待确认花费"。
- [ ] AC-020: Given build 成功, when 打开 ⑤成片, then 该片可在页面内播放，下载得到的 mp4 可被 ffprobe 正常读取。

### REQ-007: 成片库与下载

**优先级：** P0　**关联任务：** TASK-005

**行为：** ⑤成片 网格：封面帧、名称（默认取 brief 前 20 字，可改）、时长、花费、状态。点开播放器。单条下载与多选打包 zip。

**验收标准：**
- [ ] AC-021: Given 勾选 3 条完成的成片, when 点批量下载, then 得到含 3 个 mp4 的 zip，文件名为成片名。

### REQ-008: 设置与环境体检

**优先级：** P0　**关联任务：** TASK-006　**关联流程：** FLOW-001

**行为：** 见 FLOW-001。设置项：hypit-main 路径、数据根目录、TokenDance key、HypiHub 连接（可选）、Agent 模型档案与默认档案（REQ-010）、单条/批次限额、Agent 熔断（分钟/美元）、Agent 并发、渲染并发与 workers。

**规则：**
- MUST key 只存本机应用数据目录的配置文件，文件权限限当前用户；界面回显打码。
- MUST 体检每项给出"是什么、现状、怎么修"，修复命令可复制。
- MUST 凭据类体检项判定的是"验证过没有"，不是"配置了没有"。只填了一个没验证过的 key 一律算未通过，出片闸门照挡。key 一改，之前的验证结果立刻作废。
- MUST 凭据验证由 Clone Studio 直接问服务方，不经 hypit：hypit 没有校验远端凭据的命令，`doctor --endpoint` 对错误 key 也返回 ok，`auth status` 只报凭据在不在。验证必须零花费——不得为了验证而产生任何计费请求。
- MUST 验证失败时把**服务方返回的原文**（状态码 + 响应体）原样展示，不改写、不归纳。
- MUST 命令类体检项先把命令名解析成真实可执行文件再探测，不能直接按名字 spawn；否则 Windows 上以 `.cmd` 垫片分发的命令（npm 全局安装的那些）会被误报成"不在 PATH"。

**验收标准：**
- [ ] AC-022: Given ffmpeg 不在 PATH, when 打开设置页, then 该项红色并给出 `winget install --id Gyan.FFmpeg.Shared -e`；恢复后变绿。
- [ ] AC-023: Given 填入错误的 TokenDance key, when 点验证, then 显示验证失败及**服务方返回的原文**（如 HTTP 401 与 `{"error":{"message":"API 密钥不存在","code":"unauthorized"}}`），该体检项保持未通过，出片按钮保持禁用。
- [ ] AC-039: Given 一个以 `.cmd` 垫片分发的命令行工具已安装, when 打开设置页, then 该体检项显示它的真实版本，而不是"不在 PATH"。

### REQ-009: 花费台账

**优先级：** P0　**关联任务：** TASK-004

**行为：** 每个 Agent 任务记：时长、等价 token 花费（取最新一条 `result` 的 `total_cost_usd`，SDK 自称 "An estimate, not a billing statement"）。每次 build 记：估价、build-id、`receipt.id`/`url`（若有）。成片卡片显示合计；模板页头显示模板累计。

**规则：**
- MUST 两类花费都标注为"估算"，界面不出现"实际账单"字样。build 侧没有实际金额可取（见 REQ-006 估价来源）。
- MUST 有 `receipt.url` 时在花费明细里给出链接，让人能去 Provider 侧查真实账单。

**验收标准：**
- [ ] AC-024: Given 一条变体经历 1 次 Agent 任务与 1 次 build, when 查看成片详情, then 分别列出两笔花费及合计，且两笔均标"估"。

### REQ-010: Agent 模型切换

**优先级：** P0　**关联任务：** TASK-004、TASK-006

**用途：** 复刻和变体都烧 Agent token。用户手上有多家模型额度，要能按任务选便宜的或不限流的模型跑。

**行为：** 设置页维护"模型档案"列表。Agent 运行器（REQ-003）始终是 Claude Agent SDK，切模型 = 给该次会话的子进程注入不同的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`（及 opus/sonnet/haiku 三档默认模型映射）。①参考 提交处和 ④变体 提交处各有一个模型下拉，默认取设置里的"默认档案"。

内置档案与预设：

| 档案 | 接入方式 | 备注 |
|---|---|---|
| 本机 Claude Code 订阅（默认，不可删） | 不注入任何变量，走本机登录态 | |
| Anthropic API key | 仅注入 key | |
| DeepSeek（预设） | 官方 Anthropic 兼容端点 `https://api.deepseek.com/anthropic` | 用户只填 key 与模型 id；"支持看图"默认开（用户确认 DeepSeek 已支持图片输入），测试连接时带图验证 |
| 豆包 / 火山方舟（预设） | 方舟的 Anthropic 兼容端点 | 端点地址见 Q-004 |
| Gemini、ChatGPT/OpenAI（预设） | 这两家没有原生 Anthropic 兼容端点，须经用户本机自起的 LiteLLM 代理转换；base_url 预填 `http://127.0.0.1:4000` | 本应用不内置、不托管代理，设置页给出起代理的说明 |
| 自定义 | 任意 Anthropic 兼容端点 | |

**规则：**
- MUST 只支持 API key 接入。ChatGPT Plus、Gemini Advanced、豆包 App 这类聊天订阅不提供 API，界面在预设旁明说"需要 API key，聊天订阅不可用"。
- MUST 每个档案带"支持看图"开关。复刻任务必须看帧，选中不支持看图的档案启动复刻时拦截并说明；变体任务仅警告。
- MUST 每个档案带"支持联网搜索"开关。Anthropic 的 WebSearch 是服务端工具，第三方端点下不可用；该开关为关时，运行器在系统提示里告知 Agent 改用 Bash（curl / yt-dlp 等）与 WebFetch 找图，并在素材审核界面提示"该模型无原生搜索，素材缺口可能偏多"。
- MUST "测试连接"按钮：用该档案发一次最小会话，回显成功/失败与错误原文；若档案声明支持看图，附一张测试图验证。
- MUST key 的存储与回显规则同 REQ-008；key 只注入 Agent SDK 子进程，不落工作目录。
- MUST 每个 AgentJob 记录所用档案名与模型 id，台账与日志抽屉页头可见。
- MUST resume 沿用该任务原档案；换模型只能"重跑"。
- MUST 第三方端点下 SDK 成本不可信时，熔断按该档案填写的单价（输入/输出每百万 token 美元，可空）折算；单价为空则 $ 熔断失效，仅靠 45 分钟与卡死检测，并在档案上标注。
- SHOULD 首次切到非 Claude 档案时提示：hypit skill 是按 Claude Code / Codex 级 Agent 设计的，弱模型的 check 通过率和验货通过率会明显下降。

**输入：**

| 字段 | 类型 | 必填 | 校验规则 |
|---|---|---:|---|
| 档案名 | string | Yes | 1-30 字，不重名 |
| base_url | url | 除订阅/Anthropic 外必填 | http/https |
| auth token | secret | 除订阅外必填 | 非空 |
| 主模型 id | string | 除订阅外必填 | 非空 |
| 快速模型 id | string | No | 映射 haiku 档，空则同主模型 |
| 支持看图 / 支持联网搜索 | bool | Yes | 预设给默认值，可改 |
| 输入/输出单价 | number | No | ≥0 |

**状态：**
- 空状态：只有内置的订阅档案，下方"添加模型"按钮与预设列表。
- 错误：测试连接失败显示上游错误原文；档案保存但标"未验证"。
- 成功：档案标"已验证 + 时间"。

**验收标准：**
- [ ] AC-025: Given 默认安装, when 不做任何模型配置直接复刻, then 使用本机 Claude Code 订阅，AgentJob 记录档案为"本机 Claude Code 订阅"。
- [ ] AC-026: Given 已添加并验证 DeepSeek 档案, when 在 ④变体 选它提交, then Agent 子进程环境含 DeepSeek 的 base_url 与 token，日志页头显示 DeepSeek 与模型 id，同时进行的其它 Claude 任务不受影响。
- [ ] AC-027: Given 某档案"支持看图"为关, when 用它启动复刻, then 被拦截并提示原因，不创建 AgentJob。
- [ ] AC-028: Given 填错 key, when 点测试连接, then 显示上游返回的错误原文，档案标"未验证"。
- [ ] AC-029: Given 一个任务用档案 A 跑到熔断, when 点"继续", then 仍用档案 A；when 点"重跑", then 可重选档案。
- [ ] AC-030: Given 删除一个被历史任务引用的档案, when 确认删除, then 档案消失，历史 AgentJob 仍显示当时的档案名与模型 id。

### REQ-011: Codex 订阅生图 Provider

**优先级：** P1　**关联任务：** TASK-004

**用途：** 用户有 ChatGPT/Codex 订阅，让生图走订阅额度而不是按量付费。依据：用户提供的《Codex 生图配置说明》（已在用户的其它项目中实跑，不随仓库分发）。

**行为：** 在本项目代码目录（不在 `hypit-main/` 内）写一个 Hypit Provider 包，参照 `hypit-main/examples/provider-package` 与 `@hypit/endpoint-kit`，承接 `@hypit/gpt-image@1` 的生图能力。每个生图请求 spawn 一次 Codex CLI，由提示词里的 `$imagegen` 出图（走 Codex 内置 `image_gen` 工具，**底层模型不详【未验证】**——`gpt-image-2` 是 CLI fallback 路径的默认模型，内置路径的输出里没有任何字段暴露实际模型），PNG 交回 Build。设置里启用后，后端生成的 `hypit.runtime.json` 把 gpt-image 能力绑定到它。

**规则：**
- MUST 一图一进程，绝不批量。参数数组：`codex exec --ignore-user-config --json --ephemeral -c windows.sandbox="elevated" --sandbox workspace-write --skip-git-repo-check -C <临时工作目录> [--image <参考图绝对路径> …最多 4 张] -- "<提示词>"`。
- MUST `spawn(codex, args, { shell: false })`，并清掉 `NODE_OPTIONS`。
- MUST Windows 上带 `-c windows.sandbox="elevated"`；不得用 `unelevated` 或 `danger-full-access`。
- MUST 提示词里 `$imagegen` 出现且只出现一次；末尾写明"仅生成图片；不要写入、复制或修改任何其它文件"；要求把成品复制到 `./images/<name>.png`。
- MUST 成败判定：exit code 0 且产物文件存在且大小 > 0 才算成功。找图两条路互为兜底：`<cwd>/images/<name>.png`；`~/.codex/generated_images/<thread_id>/` 下修改时间落在本次运行区间内的最新 PNG（thread_id 取自 JSONL 首条 `thread.started`）。
- MUST JSONL 出现 `error` 事件，或 stderr 含 `rate limit` / `quota` → 失败，原文进 Build 错误，由"重试出片"接续。
- MUST 单张超时 10 分钟，超时 kill 子进程。JSONL 按行切分的单行上限 4 MB。
- MUST 该 Provider 的请求在 plan/pricing 里计为零价，台账记录张数。
- MUST 设置页体检增加：Codex CLI ≥ 0.128 且 `~/.codex/auth.json` 存在；提供"试出一张图"按钮。
- MUST 不支持透明背景：请求带透明背景参数时以"不支持"失败，不静默忽略。
- MUST NOT 直连 `chatgpt.com/backend-api`。
- MUST NOT 把 `--sandbox workspace-write` 收紧到禁止执行命令。内置 `image_gen` 不接受目标路径参数，Codex 是先生成到 `$CODEX_HOME/generated_images/` 再执行一条复制命令把图搬到 `./images/`，禁命令就拿不到图。
- SHOULD 并发默认 1（订阅额度约 40-50 张 / 3 小时滚动窗口）。单张固定带约 87K input tokens 开销（Codex 每次先读一遍 `imagegen/SKILL.md`，其中约 71K 命中缓存），美元计价仍为 $0，但影响单张耗时。

**验收标准：**
- [ ] AC-031: Given Codex 已登录且启用该 Provider, when 出一条含 1 个 gpt-image 请求的片子, then 该请求由 Codex 子进程完成，产物 PNG 进入 Build，台账该请求花费 $0、张数 1。
- [ ] AC-032: Given Codex 正常退出但未产出图片, when Provider 检查产物, then 该请求判失败并带 JSONL 末段原文，不产生空图。
- [ ] AC-033: Given Codex 未登录, when 打开设置页, then 体检该项未通过并提示执行 `codex login`，Provider 开关不可启用。

### REQ-012: 生视频通道切换

**优先级：** 机制、TokenDance、MiniMax 云端为 P0；ComfyUI 本地、即梦 CLI 为 P1　**关联任务：** TASK-002、TASK-003、TASK-004　**关联流程：** FLOW-002、FLOW-003

**用途：** 用户手上有多条生视频的路，成本和效果各不相同，要能按模板选定、按单条更换，并在验货时比出哪条路适合这个模板。

**通道：**

| 通道 | 模型 | 接法 | 计费 | 优先级 |
|---|---|---|---|---|
| TokenDance | Seedance 2.0/2.5、MiniMax H3 | Hypit 自带 Provider | 按量 | P0 |
| MiniMax 云端直连 | MiniMax H3 | 自写 Provider，调 MiniMax 官方视频生成 API（提交任务 → 轮询 → 取文件），key 走 env 注入 | 按量 | P0 |
| MiniMax 本地 ComfyUI | MiniMax H3 | 自写 Provider，调本机 ComfyUI HTTP 接口提交工作流、轮询、取产物 | 零价，记次数、步数与耗时 | P1，依据 `docs-inbox/minimax-h3-comfyui.md` |
| 即梦会员 CLI | Seedance | 自写 Provider，一请求 spawn 一次 CLI，同 REQ-011 的做法 | 消耗即梦积分，美元计价为 $0，台账记次数与积分消耗 | P1，依据 `docs-inbox/即梦CLI-dreamina使用文档.md`，CLI 名为 `dreamina` |

**行为：**
- 设置页"生视频通道"分区：每个通道一行，启用开关、凭据或地址、"测试"按钮、已验证时间；可设全局默认通道。
- 模板有"默认生视频通道"，新模板取全局默认。③验货 的"重出复刻片"可选通道，产生新的复刻片版本；版本切换控件上标出该版本所用通道与花费，用已有的并排播放器逐版与原片比。点"通过验货"时把当前版本的通道存为模板默认。
- ④变体 提交区显示并可改本批次通道，默认取模板默认。单条成片的"重试出片"可换通道。
- 换通道的两种情形：同一模型换通道（如 MiniMax H3 在 TokenDance、云端直连、本地之间换）只改后端生成的 runtime `bindings`，不动 SVML、不烧 Agent；跨模型换通道（Seedance ↔ MiniMax H3）需要改 SVML 的生视频节点，由后端 resume 该条的 Agent 会话执行一次"改用某模型"的短任务，check 通过后再过花钱闸门。界面在用户选择跨模型通道时明说"需要 Agent 改稿，约数分钟"。

**规则：**
- MUST 每次 build 记录所用通道与模型；台账、成片卡片、版本切换控件可见。
- MUST 估价闸门按所选通道计价；零价通道照常走闸门但估价为 $0，仍记次数。
- MUST 通道未启用或未验证时不可选，并给出原因。
- MUST 自写 Provider 放 `clone-studio/providers/`，不动 `hypit-main/`；各自带不发真实请求的生命周期测试。
- MUST 本地 ComfyUI 通道并发固定 1（全机一把 GPU 锁），且与本地 WhisperX 转写互斥排队。
- MUST 本地 ComfyUI 的超时按片长算：`max(30 分钟, 请求秒数 × 6 分钟)`，上限 120 分钟，可配（实测 RTX 5060 Ti、20 步：6.6 秒段约 23 分钟，9.4 秒段 41-44 分钟，10.1 秒段约 47 分钟）。超时后只停止轮询并标"超时待查"，不得重新提交；界面提供"继续等待"与"取消本地任务"。
- MUST 本地 ComfyUI 提交前把工作流图落盘；没拿到 prompt_id 时不重发，按指纹（提示词、seed、filename_prefix、全部 LoadImage 文件名）到 `/queue` 与 `/history` 找回，命中多条则报错交人；ComfyUI 重启导致历史丢失时明确提示"本地服务断开，需要重新生成"，由用户决定。取消时 `POST /queue` 删除与 `POST /interrupt` 两个都调。
- MUST 本地 ComfyUI 的输入校验：仅 768p（短边 768、长边对齐 32、面积 ≤ 768×1344），不支持 2K；时长 4-15 秒，帧数按 24fps 吸附到 17k+5；提示词 ≤ 7000 字符，超了拒绝不截断；R2V 接 1-9 张参考图，FL2VA 恰好首尾两张。下载后必须验真（可被 ffprobe 读取、时长与帧格相符）。
- MUST 即梦通道按文档走异步：提交得 `submit_id` → `query_result` 轮询 `gen_status` → `--download_dir` 取片；参数在提交前本地严格校验；`AigcComplianceConfirmationRequired` 判为"需先在网页端授权该模型"并原样提示，不重试；`ExceedConcurrencyLimit` / `ret=1310` 判为限流，退避重试；解析输出取第一个 `{` 到最后一个 `}`。登录只能由用户手动完成设备码确认，应用不代登；体检用 `dreamina user_credit` 显示账号、会员等级与剩余积分；Seedance 2.5 仅 VIP 可选。
- MUST 把当前已启用通道及各自支持的模型与限制（时长、分辨率、是否接受真人脸参考、是否带声音）写进 Agent 系统提示。
- MUST 即梦 CLI 与 ComfyUI 两个通道只按 `docs-inbox/` 里的使用文档实现；文档标注【未验证】的能力（真人照片参考、15 秒段、Turbo 提速）在界面与 Agent 系统提示里同样标"未验证"，不当作已支持。
- MUST 删除路径：通道凭据可清除；停用通道不影响历史记录的显示。

**验收标准：**
- [ ] AC-034: Given TokenDance 与 MiniMax 云端均已验证, when 在 ③验货 选 MiniMax 云端重出复刻片, then 产生新版本，版本控件显示其通道与花费，未启动任何 Agent 任务（同为 MiniMax H3 时）。
- [ ] AC-035: Given 模板 SVML 用的是 MiniMax H3, when 重出时选 Seedance 通道, then 界面提示需要 Agent 改稿，确认后 resume 原会话改节点、check 通过、过闸门后出片。
- [ ] AC-036: Given 验货通过时当前版本通道为 X, when 进入 ④变体, then 批次通道默认是 X，可改。
- [ ] AC-037: Given 某通道未验证, when 打开任一通道下拉, then 该项置灰并显示原因。
- [ ] AC-038: Given 一条成片先后用两个通道各出过一次, when 查看花费明细, then 两次 build 分别列出通道、模型、估价与实际。

### AI 能力规格

| AI 功能 | 能力类型 | 质量条 | 触发方式 | 不确定时 | 服务降级 |
|---|---|---|---|---|---|
| 复刻（视频→SVML） | agent（多模态理解+代码生成） | 产物 100% 通过 `hypit check`；人工验货一次通过率目标 ≥60%，低于 40% 需回头改系统提示 | 导入完成后自动启动；结果须人工验货 | 写进 ANALYSIS.md 的"不确定项"，验货时展示 | 订阅限流→等待额度自动续跑；SDK 不可用→任务失败可重试 |
| 写变体（模板+brief→变体 SVML+素材） | agent | 100% 通过 check；批量无干预成片率 ≥80% | 提交批量后自动；素材须人工审 | 找不到可识别图时在 SOURCES.json 标注缺口，审核界面标红 | 同上 |
| 转写对齐 | 语音转文字（本地 WhisperX） | 词级时间戳可用 | 自动 | 无人声则跳过并告知 Agent | 本地服务未起→体检拦截 |
| 图/视频生成（TokenDance 为主，HypiHub 可选补 TTS 等） | 生成 | 由人工验货与素材审核把关 | 过花钱闸门后自动 | — | Provider 报错→build 失败可重试 |

**AI 护栏（绝不能做）：**
- Agent 绝不能自己触发花钱的 build；最贵的错是失控循环出片，靠 `canUseTool` 拦截 + 后端独占 build + 双层限额防。
- Agent 绝不能写工作目录与其 assets 之外的路径，绝不能改 `hypit-main/`。系统提示声明 + `canUseTool` 对写路径做前缀校验。
- Agent 绝不能读取或输出 TokenDance / HypiHub 等生成服务 key；key 不进 Agent 进程环境。
- 未经人工素材审核的联网图片绝不进入成片。

---

## 6. 数据模型

### 6.1 核心实体

| 实体 | 描述 | 关键字段 |
|---|---|---|
| Client | 客户 | id, name, created_at |
| Template | 一条参考视频及其复刻模板 | id, client_id, name, language, default_video_channel, source_kind(file/url), source_url, workspace_path, status(importing/cloning/awaiting_review/approved/failed), note |
| Production | 一条要出的片：复刻片或变体 | id, template_id, kind(replica/variant), batch_id, brief, name, status, run_path, version |
| Batch | 一次批量提交 | id, template_id, note, target_language, budget_usd, spent_usd |
| AgentJob | 一次 Agent 会话 | id, owner(template/production), session_id, status, started_at, ended_at, cost_usd, cost_is_estimate, stop_reason, profile_name, model_id（后两项为快照，不随档案删除而变） |
| ModelProfile | Agent 模型档案 | id, name, kind(subscription/anthropic/compatible), base_url, token(加密存配置文件，不入库明文), model_id, fast_model_id, supports_vision, supports_web_search, price_in, price_out, verified_at, is_default, builtin |
| AgentMessage | Agent 流式消息 | id, job_id, seq, role, type, payload |
| VideoChannel | 生视频通道配置 | id, kind(tokendance/minimax_cloud/minimax_comfyui/jimeng_cli), enabled, config(地址等，凭据存 secrets.json), verified_at, is_default |
| Build | 一次 hypit build | id, production_id, video_channel, video_model, hypit_build_id, estimate_usd, actual_usd, status, error_code, error_message, output_path |
| Asset | 变体条目素材 | id, production_id, file_path, source_url, replaced_by_user |
| Settings | 单例配置 | 见 REQ-008 |

### 6.2 实体关系

| 关系 | 描述 |
|---|---|
| Template belongs to Client | 级联删除 |
| Production belongs to Template | replica 每版本一条，variant 每 brief 一条 |
| Production belongs to Batch | 仅 variant |
| AgentJob / Build / Asset belong to Production（复刻 AgentJob 属 Template） | 级联删除 |

### 6.3 数据规则

- 元数据存本地 SQLite；媒体与 Hypit 工程文件存数据根目录 `<data>/clients/<id>/templates/<id>/`，数据库只存路径。
- 状态迁移只由后端任务调度器写，前端只读 + 发动作。
- 删除先停任务、再删目录、最后删库；任一步失败则整体报错并保留记录。
- 无权限模型：单机单用户，后端只监听 127.0.0.1。

---

## 7. 外部依赖

| 编号 | 依赖 | 用途 | 是否必需 | 备注 |
|---|---|---|---:|---|
| DEP-001 | Hypit 0.2.6（`hypit-main/`，源码分发，tsx 直跑） | 内核：证据工具、check/plan/pricing/build/get | Yes | 需 `pnpm install --frozen-lockfile`；当前未安装 |
| DEP-002 | Node.js ≥22.15、pnpm 10.33 | 运行 Hypit 与本应用后端 | Yes | |
| DEP-003 | `@anthropic-ai/claude-agent-sdk`（TypeScript） | 无头驱动复刻/变体 Agent | Yes | 自带 Claude Code 二进制；用 query、canUseTool、maxBudgetUsd、resume、skills |
| DEP-004 | 本机 Claude Code 订阅登录 | Agent 默认认证 | Yes | 2026-06-15 起无头用量走独立周额度池；订阅凭据仅限个人本机使用 |
| DEP-010 | DeepSeek Anthropic 兼容端点 `https://api.deepseek.com/anthropic` | 可选 Agent 模型 | No | 官方支持 Claude Code 接入；对 metadata.user_id 字符集有限制，测试连接时验证 |
| DEP-011 | 火山方舟（豆包）Anthropic 兼容端点 | 可选 Agent 模型 | No | 见 Q-004 |
| DEP-012 | LiteLLM 代理（用户自起） | 把 Gemini / OpenAI 转成 Anthropic Messages 格式 | No | 本应用不内置；经代理时 WebSearch 工具不可用 |
| DEP-005 | TokenDance API key（`https://tokendance.space`，用户已订阅） | Seedance 视频、Seedream 生图、MiniMax H3 视频 | 出片必需 | 不含配音 TTS 与 GPT Image；Seedance 2.0/2.5 拒绝含真人脸的参考图/视频 |
| DEP-013 | HypiHub（`https://hypit.ai`） | 补 TokenDance 没有的能力：TTS、GPT Image 等 | No | 无需找 key 页面：`hypit auth login hypihub.default` 走浏览器 OAuth 授权；也可 `--from <key 文件>` 导入静态 key |
| DEP-015 | MiniMax 官方视频生成 API + 用户已开通的 API key | REQ-012 云端直连通道 | No | 开发前联网核对当前接口与 H3 模型名 |
| DEP-016 | 本机 ComfyUI（已安装，含 MiniMax H3 工作流） | REQ-012 本地通道 | No | P1，接口以用户另一项目出的使用文档为准 |
| DEP-017 | 即梦 / Dreamina 会员 + 命令行工具 | REQ-012 即梦通道 | No | P1，CLI 名称与用法待用户提供 |
| DEP-014 | 本机 Codex CLI ≥0.128（本机 0.153.4）+ ChatGPT 订阅登录 | REQ-011 订阅生图 | No | P1；无需 API key |
| DEP-006 | ffmpeg + ffprobe | 媒体处理与编码 | Yes | |
| DEP-007 | uv | Hypit 的 Python 服务环境 | Yes | |
| DEP-008 | WhisperX 本地服务 + NVIDIA GPU | 词级转写 | Yes | `provider-whisperx-local` |
| DEP-009 | Chrome for Testing | Hypit 渲染 | Yes | `hypit programs prepare` 预热 |

---

## 8. 非功能需求

| 类别 | 要求 | 优先级 |
|---|---|---|
| 性能 | 界面操作响应 ≤300ms；Agent 消息从产生到抽屉显示 ≤1 秒；默认并发 2 Agent + 1 渲染，渲染 workers 默认 4 | P0 |
| 安全 | 后端只绑 127.0.0.1；Agent 写路径限工作目录；build 拦截；key 不进 Agent 环境、不落工作目录 | P0 |
| 隐私 | 数据全在本机；除所选 Agent 模型服务、TokenDance / HypiHub、Agent 联网搜图外无外发；不做遥测 | P0 |
| 兼容性 | Windows 11，Chrome/Edge 最新版，视口 ≥1280px；不做移动端 | P0 |
| 可靠性 | 崩溃/蓝屏重启后无数据丢失，进行中任务标"中断"可继续；所有子进程随后端退出而清理；hypit 调用失败保留原始错误 | P0 |
| 可访问性 | 不要求 | — |

---

## 9. 完成定义

- [ ] 所有 P0 requirements 已实现
- [ ] 所有 P0 acceptance criteria 已通过
- [ ] FLOW-001 至 FLOW-004 可端到端完成
- [ ] 端到端验收样本：用 `hypit-main/examples/ranking-football` 同类的一条真实排行榜参考视频，走完 导入→复刻→验货→提交 3 条变体→素材审核→出片→下载
- [ ] 主要错误状态、空状态、加载状态已处理
- [ ] Product Spec 和 Design Brief 中的 P0 内容保持一致

---

## 10. 假设与待确认问题

### 10.1 假设

| 编号 | 假设 | 假设依据 | 错误风险 |
|---|---|---|---|
| ASM-001 | 变体由 Agent 重写 SVML，而非程序化改字段 | Hypit 排行榜示例 swap-topic 是整份 33KB 重写的 SVML | 若多数变体其实只换几个字段，则白烧 token；可二期加"快速变体"通道 |
| ASM-002 | ~~订阅登录下 SDK 仍返回可用的 total_cost_usd 供 $5 熔断使用~~ **已验证成立**（Phase 0） | 五组实跑均返回 number 型真实数值（0.0143-0.0518），`modelUsage` 另给分模型用量 | 已消解。改用 SDK 原生 `maxBudgetUsd` 熔断，见 REQ-003 |
| ASM-012 | ~~`canUseTool` 可作为拦截花钱动作的主手段~~ **已验证不成立**（Phase 0） | 默认沙箱自动放行、只禁 Bash 会被 Task 绕开，实测四组中三组命令照样执行 | 已消解。改用 `disallowedTools`（必含 `Task`），见 REQ-003 |
| ASM-003 | 订阅无头周额度够跑日常批量 | 2026-06 起无头独立额度池 | 不够则批量经常停在"等待额度"；此时切到 REQ-010 的其它模型档案 |
| ASM-011 | 生成服务以 TokenDance 为主即可跑通 P0 验收样本 | 用户已订阅；Hypit 内置其 Provider | 参考片依赖 TTS 或 GPT Image 时 plan 会缺能力，需连 HypiHub 或等 REQ-011 |
| ASM-009 | 切模型靠给 Agent SDK 子进程注入 `ANTHROPIC_BASE_URL` 等环境变量实现，不换 Agent 框架 | DeepSeek 官方文档与 LiteLLM 教程均以此方式接 Claude Code | 某家端点与 SDK 新版本不兼容时该档案不可用；靠"测试连接"提前暴露 |
| ASM-010 | 非 Claude 模型跑 hypit skill 的成功率显著低于 Claude，且 DeepSeek 等纯文本模型无法做复刻 | skill 为 Claude Code / Codex 级 Agent 设计；复刻必须看帧 | 用户对切换后的质量预期过高；界面已拦截与提示 |
| ASM-004 | 技术栈：后端 Node+TypeScript（Fastify）、SQLite、SSE；前端 React+Vite | Hypit 与 Agent SDK 均为 TS/Node，同栈最省胶水 | 低 |
| ASM-005 | 集成方式：spawn hypit CLI 子进程，不 import 内部包 | 内部包 private 且无 semver 保证 | tsx 冷启动慢，每次调用多几秒；可接受 |
| ASM-006 | 参考视频时长上限 180 秒、单批 ≤20 条 | 短视频场景 + 限额 $15 的量级 | 上限可在设置里放开 |
| ASM-007 | Hypit 许可证允许工作室内部使用并交付成片给客户 | 上一轮已读 LICENSE 并据此给出选项 | 若有误需联系 Hypit.AI；对外 SaaS 已排除 |
| ASM-008 | 产品名 Clone Studio、代码目录 `clone-studio/` | 用户未命名 | 改名成本低 |

### 10.2 待确认问题

| 编号 | 问题 | 是否阻塞 | 备注 |
|---|---|---:|---|
| Q-001 | 排行榜类片子的旁白/主持人声音怎么来：TokenDance 无独立 TTS | 阻塞含配音片子的出片验收，不阻塞开发 | 三条路：Seedance 直出带声音的口播镜头；连 HypiHub 用其 TTS；用户自供音频。默认先走第一条，不够再连 HypiHub |
| Q-002 | 联网搜图的版权风险由用户自担，是否需要在审核界面加免责提示 | No | 默认加一行小字 |
| Q-004 | 火山方舟当前的 Anthropic 兼容端点地址、模型 id 与是否支持图片输入 | No | 开发到 REQ-010 时联网核实后写进预设；核实不到则豆包预设降为"自定义"并由用户自填 |
| Q-005 | 用户的 Gemini / ChatGPT 是聊天订阅还是 API key | No | 聊天订阅无法接入；只有 API key 能用，且需自起 LiteLLM |
| Q-007 | Hypit 能否从 `hypit-main/` 之外加载自写 Provider 包（`--package-root` 或项目 `packages/`），以及 gpt-image 能力的请求/响应契约 | No | 已基本解答：`hypit-main/examples/provider-package` 证明项目自有 Provider 放在包目录、经 runtime profile 的 `bindings` 绑到 `@hypit/gpt-image@1#gpt-image-2` 即可；剩 `--package-root` 指向 hypit-main 之外目录的实测，排在 DEV-PLAN Phase 11 |
| ~~Q-003~~ | **已解答（Phase 0）**：`hypit pricing` 给不出可用估价，build 后也拿不到实际花费 | 不再阻塞 | `pricing.kind` 仅 `page`/`local`，Result 无金额字段。兜底方案转为正式决定：Clone Studio 自维护费率表算估价、全部花费标"估"，见 REQ-006 估价来源与 REQ-009。证据见 `clone-studio/docs/spike-notes.md` 验证一 |

---

## 11. Agent 系统规格

### 11.1 自主性与人在回路

| 动作类别 | 自主级别 | 审批 / 回滚 |
|---|---|---|
| 读参考证据、写分析与 SVML、跑 check/vocabulary/snapshot/media 工具 | 自动 | 产物在工作目录，重跑即覆盖 |
| 联网搜索与下载素材 | 自动 | 出片前人工素材审核 |
| 花钱的 build | Agent 禁止；宿主在限额内自动、超限人工确认 | 不可回滚，故设双层限额 |
| 写工作目录之外、改 hypit-main、读 key | 禁止 | canUseTool 拦截 |
| 模板放行 | 人工验货 | 可打回重做 |

### 11.2 工具与能力集

| 工具 / 能力 | 用途 | 权限级别 | 扩展机制 |
|---|---|---|---|
| Claude Code 全工具集（Bash、Read/Write/Edit、Glob/Grep、WebSearch、WebFetch） | 复刻与写变体 | 执行，受 canUseTool 两条硬拦截约束 | 无（v1 不开放用户加 MCP） |
| hypit skill（`skills/hypit`，SKILL.md + references） | 领域知识 | 只读 | 随 hypit-main 版本更新 |

### 11.3 上下文与记忆

- 单任务上下文：依赖 SDK 自动压缩；Agent 按 hypit skill 约定写 `PROGRESS.md`，resume 或重开会话时先读它。
- 跨会话记忆：无全局记忆。模板级知识全部沉淀在工作目录文件里（ANALYSIS/TIMELINE/SVML），变体 Agent 从文件读取。

### 11.4 编排与多 agent

- 一个任务一个 Agent 会话，互相隔离在各自目录；变体目录只读引用模板源文件的副本。不做子 Agent 编排。调度器控制并发。

### 11.5 评估与可观测（Eval）

- 评估方式：硬指标 `hypit check` 通过率；人工指标为验货一次通过率、素材审核打回率，由台账数据库可查。固定回归样本：ranking-football 同类参考视频 1 条。
- 可观测：全部 Agent 消息与工具调用落库可回看；每次 hypit 调用记录命令、退出码、JSON 输出。
- 质量退化：模板页显示该模板历史打回次数；一次通过率 <40% 视为需改系统提示。

### 11.6 成本与预算

- Agent：单任务 $5 / 45 分钟熔断。生成模型：单条 $1.5、批次 $15，限额内自动。全部可在设置页改。
- 模型路由：不做自动路由。用户按任务手选模型档案（REQ-010），默认本机 Claude Code 订阅。第三方档案的 $ 熔断按档案单价折算，单价为空则只剩时间与卡死两道保险。

### 11.7 失败与卡死

- 同命令连续失败 5 次或 10 分钟无消息 → 停。熔断后保留产物，人选"继续"或"重跑"。
- 交回人的条件：熔断、check 最终不过、plan 有未解析请求、估价超限、素材待审。

### 11.8 会话与状态

- session id 落库，支持 resume；后端重启后运行中任务标"中断"。
- transcript 全量保留在本地数据库，随所属对象删除。
