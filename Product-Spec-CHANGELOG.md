# 变更记录

## [v1.7] - 2026-09-20
> 本版改动来自 Phase 3 收口审查：两条产品规则此前只活在代码里，Spec 没有出处，其中一条还与 FLOW-002 冲突。经用户拍板回写。

### 修改
- **SCOPE-004 备注**：「通过才解锁变体」→「通过才解锁变体与成片」。
- **REQ-004 规则**：原「未通过验货的模板，④变体 步骤锁定」扩为「④变体 与 ⑤成片 两步均锁定」。验货是质量闸门，没过之前不产出可交付的东西；复刻片在 ③验货 的并排播放器里看得到，不需要靠 ⑤成片 去看。
  - 起因：Phase 3 实现成「有成片（outputs > 0）就解锁 ⑤」，与 FLOW-002 完成状态「模板标记已验货，复刻片作为该模板下第一条成片入库」直接冲突——按 Spec 字面，复刻片是在验货通过那一刻才成为成片的。代码已按本条改回。

### 新增
- **REQ-004 规则**：「通过」验货这一个动作同时解锁 ④变体 与 ⑤成片，复刻片此时入库成片。
- **REQ-001 规则**（模板页导航，此前 Spec 与 Design-Brief 均无规定）：
  - 进入模板页默认落在需要人动手的那一步，优先级 需处理 ＞ 进行中 ＞ 失败 ＞ 能进入的最后一步。目的是打开就知道该干什么，不用从 ①参考 一路点过去找。
  - 当前步骤写进地址，刷新停在原处；地址里指定的步骤只要已解锁就照它走，不被默认规则覆盖。
  - 地址里指定了未解锁或不存在的步骤时，送回按上面规则算出的那一步，不给空白页。
- AC-040：模板未验货且复刻片已出时，④变体 与 ⑤成片 均未解锁且不可点；点「通过」后两步同时变为可进入。

---

## [v1.6] - 2026-09-20
> 本版改动来自 Phase 2 实做中撞到的事实，与 DEV-PLAN 同步修订。

### 修改
- **REQ-008 凭据验证换机制**：hypit 没有校验远端凭据的命令——`doctor --endpoint tokendance.default` 对故意写错的 key 也返回 `ok: true`，`auth status` 只报凭据在不在。改为由 Clone Studio 直接问服务方，且必须零花费。
- **REQ-008 新增规则**：凭据类体检项判定"验证过没有"而不是"配置了没有"；key 一改即作废之前的验证结果。原先只看配置与否，填个乱码也算通过，AC-023 要求的"出片按钮保持禁用"挡不住。
- **REQ-008 新增规则**：命令类体检项必须先把命令名解析成真实可执行文件再探测。Windows 上以 `.cmd` 垫片分发的命令（npm 全局安装）直接按名字 spawn 会被误报成"不在 PATH"。
- **AC-023 措辞更正**：原文写"显示 Hypit 返回的原因"，实际原因来自服务方而非 Hypit；改为要求原样展示服务方的状态码与响应体。

### 新增
- AC-039：以 `.cmd` 垫片分发的工具，体检须显示其真实版本而非"不在 PATH"。

---


## [v1.5] - 2026-09-20
> 本版全部改动来自 Phase 0 先行验证的实跑结论，证据见 `clone-studio/docs/spike-notes.md`。

### 修改
- **REQ-003 拦截机制换底**：`canUseTool` 实测拦不住花钱动作——默认 `sandbox.autoAllowBashIfSandboxed` 为 true 使其根本不被调用，且只禁 `Bash` 时模型会派 `Task` 子 Agent 绕开照样执行。主拦截改为 `disallowedTools` 且必含 `Task`；拦截记录由宿主自写，不读恒为空的 `permission_denials`。AC-007 措辞同步。
- **REQ-003 新增会话隔离要求**：必须传 `settingSources: []`，否则继承用户本机 `~/.claude` 的权限规则与 hooks。
- **REQ-003 熔断改用 SDK 原生**：`maxBudgetUsd` + `error_max_budget_usd`，不自己累加；`total_cost_usd` 只取最新一条 result（resume 会续上累计值）。
- **REQ-006 估价来源改由自己算**：hypit 的 `pricing.kind` 只有 `page`（价格页 URL）与 `local`（零价），无结构化费率，官方文档明言 "Hypit itself calculates no total"。改为 Clone Studio 自维护费率表，用 `plan --json` 的 `needs[].summary.fields` 计算，界面同时展示价格页链接供人工核对。
- **REQ-006 / REQ-009 花费口径改为"估"**：build 的实际花费无处可取（Result 只有不含金额的 `receipt`），两类花费一律标估算，不出现"实际账单"字样；有 `receipt.url` 时给链接。
- **REQ-011 底层模型标【未验证】**：Codex 走的是内置 `image_gen` 工具而非 CLI fallback，`gpt-image-2` 是 fallback 的默认模型，本次输出无字段暴露内置路径实际模型。
- **REQ-011 新增沙箱约束**：不得把 `--sandbox workspace-write` 收紧到禁止执行命令——内置 `image_gen` 不接受目标路径参数，Codex 靠执行复制命令把图搬到 `./images/`。补记单张约 87K input tokens 的固定开销。

### 结论落定
- **ASM-002 成立**：订阅登录下 `total_cost_usd` 五组实跑均返回真实数值（0.0143-0.0518），$5 熔断可行。
- **ASM-012 新增并判定不成立**：`canUseTool` 不能作为拦截主手段（见上）。
- **Q-003 已解答且为否**：估价与实际花费都拿不到。原兜底方案"拿不到则全部走人工确认"转为正式决定。
- REQ-011 Codex 生图实跑成功：退出码 0，产出 838KB 有效 PNG，Spec 描述的两条找图路径均成立。

---


## [v1.4] - 2026-09-19
### 修改
- REQ-012 本地 ComfyUI 通道的超时从"固定 30 分钟"改为按片长计算 `max(30 分钟, 秒数 × 6 分钟)`、上限 120 分钟；超时只停轮询标"超时待查"，不重新提交。依据用户另一项目的实测耗时。
- REQ-012 补入本地 ComfyUI 的输入约束、指纹找回、重启丢历史、取消与验真规则；补入即梦 `dreamina` CLI 的异步流程、严格参数校验、授权与限流两类错误的处理、手动登录与积分体检。
- 即梦通道计费从"零价记次数"改为"美元 $0，另记积分消耗"。
- 文档标【未验证】的能力在界面与 Agent 提示里同样标未验证。

### 删除
- Q-008、Q-009（两份使用文档已到 `docs-inbox/`）。

---

## [v1.3] - 2026-09-19
### 新增
- 新增 REQ-012 / SCOPE-015 生视频通道切换：TokenDance、MiniMax H3 云端直连（P0）、MiniMax H3 本地 ComfyUI、即梦会员 CLI（P1，等使用文档）。设置页新增"生视频通道"分区；③验货 的"重出复刻片"、④变体 提交区、成片"重试出片"各增加通道下拉；版本切换控件标出通道与花费。
- 同模型换通道只改 runtime bindings；跨模型换通道由 Agent 短任务改 SVML 节点。
- 新增 AC-034 至 AC-038、实体 VideoChannel、DEP-015 至 DEP-017、Q-008、Q-009。
- 新增 OUT-008：不做多模型同出并排、逐镜头选优（用户明确只要切换）。

### 修改
- OUT-005 收窄为"未列入 REQ-011、REQ-012 的 Provider 不做"。
- Template 增加 default_video_channel；Build 增加 video_channel、video_model。

---

## [v1.2] - 2026-09-19
### 修改
- REQ-011 Codex 订阅生图 Provider 按用户提供的《Codex生图配置说明》定稿：一图一进程 spawn `codex exec` + `$imagegen`（gpt-image-2），Windows 必带 `windows.sandbox="elevated"`，按文件存在判成败，10 分钟超时，并发默认 1；补齐 AC-031 至 AC-033。设置页体检增加"Codex CLI 与登录"一行和"试出一张图"按钮。
- DEP-014 写明 Codex CLI 版本要求。

### 新增
- Q-007：Hypit 从外部加载自写 Provider 包的方式待先行验证。

### 删除
- Q-006（文档已到手）。

---

## [v1.1] - 2026-09-19
### 新增
- 新增 REQ-011 / SCOPE-014（P1）：Codex 订阅生图 Provider，用本机 Codex 生图模式走订阅额度出图；等用户提供接入文档后定稿（Q-006）。设置页体检届时增加"Codex 已安装且已登录"一项。
- 新增 DEP-013 HypiHub 为可选补充服务，连接方式为 `hypit auth login hypihub.default` 浏览器 OAuth，不需要手填 key。
- 新增 REQ-006 规则：后端按已验证的生成服务生成 runtime 配置，并把可用能力清单写进 Agent 系统提示。

### 修改
- 生成服务主力从 HypiHub 改为 TokenDance（用户已订阅）：SCOPE-010、FLOW-001、REQ-006、REQ-008、AC-023、DEP-005 同步；设置页凭据区改为"TokenDance key + HypiHub 连接（可选）"。
- OUT-005 从"HypiHub 以外的 Provider 不做"改为"TokenDance、HypiHub 之外的 Provider 不做"。
- REQ-010 DeepSeek 预设的"支持看图"默认值从关改为开（用户确认 DeepSeek 已支持图片输入），可用于复刻任务。
- Q-001 从"HypiHub key 何时到位"改为"旁白/配音来源"：TokenDance 无独立 TTS。

---

## [v1.0] - 2026-09-19
- 初始版本（含 REQ-010 Agent 模型切换）
