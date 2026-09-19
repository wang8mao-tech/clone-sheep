# 变更记录

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
