# 变更记录

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
