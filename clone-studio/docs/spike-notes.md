# Phase 0 先行验证记录

> 记录日期：2026-09-20　执行环境：Windows 11 Pro 22631 / Node v24.11.1 / pnpm 11.6.0 / ffmpeg 2026-01-19 / uv 0.11.21 / Hypit 0.2.6（本地副本 `hypit-main/`）
>
> 本文件是 Phase 0 三项先行验证的结论与证据。每条结论都标"成立 / 不成立"并附当场跑出的真实输出。
> 与 Product-Spec 假设不符的部分，已回写 Spec 并记入 `Product-Spec-CHANGELOG.md`。

## 环境就绪确认

```
$ node --version                                  v24.11.1
$ pnpm --version                                  11.6.0
$ ffmpeg -version | head -1                       ffmpeg version 2026-01-19-git-43dbc011fa-essentials_build
$ uv --version                                    uv 0.11.21
$ node hypit-main/bin/hypit.mjs --version         0.2.6
```

```json
$ node hypit-main/bin/hypit.mjs doctor --json
{
  "format": "hypit.cli-doctor@1",
  "ok": true,
  "project": "X:\workflow\clone workflow",
  "profileSource": "none",
  "diagnosticCount": 0,
  "diagnostics": []
}
```

本机 pnpm 为 11.6，与 `hypit-main` 声明的 pnpm@10.33 不一致，但 `hypit-main/node_modules` 已装好且 CLI 正常执行，**未动用 corepack 降版**。

---

## 验证一：hypit 全链路与花费可得性（解 Q-003）

**Q-003 原文**：`hypit pricing` 对 TokenDance 是否能给出可用估价、build 后能否拿到实际花费。

### 载体选择

`hypit-main/examples/minimal-author-package` 走不通：它的 `@example/example-component` 需要先编译出 `dist/`，而编译会往 `hypit-main/` 里写文件，违反"不修改 hypit-main"的约束。

```json
$ node hypit-main/bin/hypit.mjs check "hypit-main/examples/minimal-author-package/packages/example-component/preview/build.svrun" --workspace "hypit-main/examples/minimal-author-package" --json
{
  "format": "hypit.cli-error@1",
  "ok": false,
  "error": {
    "code": "ENOENT",
    "message": "ENOENT: no such file or directory, stat '...\example-component\dist\activation.js'"
  }
}
```

改用 `examples/complex-explainer`：它的 `runs/render.svrun` 用 `build-record` + `satisfy` 复用 50 个已接受的 Output，只剩本地渲染与 mux 三个请求，**不触发任何付费 Provider**，可以零花费跑通全链路。整个 example 复制到工作区副本操作，`hypit-main/` 全程只读。复跑脚本见 `clone-studio/scripts/spike-hypit.ps1`。

### 各命令的真实 JSON 形状

`check`（只读校验，不需要 Runtime Profile）：

```json
{
  "format": "hypit.cli-check@1",
  "sourceKind": "run",
  "ok": true,
  "run": "productions\explainer\runs\render.svrun",
  "author": "productions\explainer\authors\main.svml",
  "frontend": "@hypit/run-markup@1",
  "targetCount": 1,
  "targets": ["complete-film.video"],
  "candidates": 50,
  "satisfactions": 50,
  "historicalOutputCount": 50
}
```

`plan --json` 顶层字段：

```
format = hypit.cli-plan@1        ok = false（preflight 未过时为 false）
targetCount = 1                  targets = array[1]
requestCount = 3                 requestIssueCount = 0
providerRequestCount = 0         localRequestCount = 3
unresolvedRequestCount = 0       unsupportedRequestCount = 0
choiceCount = 50
providers = array[3]             needs = array[3]
preflight = { ok, capabilityCount, diagnosticCount, diagnostics }
```

`providers[]` 每项带 `pricing`，这是估价的唯一来源：

```json
{
  "capability": "@hypit/render-hyperframes@1#render-visual",
  "status": "resolved",
  "endpoint": "hyperframes.local",
  "use": "@hypit/provider-hyperframes-local",
  "pricing": { "kind": "local" },
  "binding": "hyperframes.local"
}
```

`needs[]` 每项带执行参数，可直接用于估算工作量：

```json
{ "port": "visual", "summary": { "fields": { "width": 1080, "height": 1920, "startFrame": 0, "endFrameExclusive": 900, "frameRate": "30/1" } } }
{ "port": "audio",  "summary": { "fields": { "startFrame": 0, "endFrameExclusive": 900, "frameRate": "30/1", "sampleRate": 48000 } } }
```

`preflight` 是体检信息的直接来源，**Phase 2 的环境体检可以直接消费它**：

```json
{
  "ok": false,
  "capabilityCount": 3,
  "diagnosticCount": 1,
  "diagnostics": [
    {
      "severity": "error",
      "code": "MANAGED_PROGRAM_DOWN",
      "message": "hyperframes.local is not usable: Render browser is unavailable at ...chrome-headless-shell.exe: ENOENT... Prepare the selected Runtime with hypit runtime up --runtime <profile>, or correct its chromePath.",
      "subject": "hyperframes.local"
    }
  ]
}
```

诊断项自带 `severity` / `code` / `message` / `subject`，且 message 里直接写明修复命令。`hypit runtime up --runtime <profile>` 执行后装上 Chrome Headless Shell 152.0.7928.2，再跑 plan 即 `ok: true`、`diagnosticCount: 0`。

`pricing --json`（零价工作）：

```json
{
  "format": "hypit.cli-pricing@1",
  "run": "productions\explainer\runs\render.svrun",
  "requestCount": 3,
  "noChargeRequestCount": 3,
  "groups": []
}
```

### `build --follow --json` 与 `get` 的真实形状

`build --follow --json` 先往 stderr 刷进度行，最后在 stdout 给一份 JSON。进度行的形状：

```
· Working · 0/3 steps complete · 9s
· Working · 0/3 steps complete · 1 preparing resources · 29s
· Working · 1/3 steps complete · 1 decoding source frames · 1425/2040 frames · 56s
· Working · 1/3 steps complete · 1 rendering frames · 476/900 frames · 4m 41s
· Working · 1/3 steps complete · 1 encoding video · 7m 56s
· Saving Result · 1/3 steps complete · 8m 21s
```

阶段名（`preparing resources` / `decoding source frames` / `starting browsers` / `rendering frames` /
`encoding video` / `Saving Result`）与 `x/y frames` 可直接喂给 CMP-007 出片进度条。

失败时的 JSON（本机实跑，见下文"本机渲染不通"）：

```json
{
  "format": "hypit.cli-build@1",
  "build": {
    "id": "bld_20260920T004652769Z_2D27EBCB17",
    "targets": ["export-part-1.video"],
    "failure": "Command need:...:request-visual-render ended without a stored result: Endpoint hyperframes.local failed render-visual: Rendered visual frame rate differs from its document
[hyperframes] browserGpuMode probe ... ; caused by: Rendered visual frame rate differs from its document",
    "work": { "state": "done", "outcome": "failed" },
    "result": { "state": "failed", "outputCount": 74 }
  }
}
```

**要点**：`build.work.state` 为 `done` 但 `build.result.outcome` 为 `failed` —— 判成败必须看
`result.outcome`／`result.state`，不能看 `work.state`。`failure` 是一整段人类可读文本，
不是结构化错误码，界面要原样展示。`outputCount` 记的是已落盘的 Output 数，失败时也非零。

`get` 的真实形状（对媒体包自带的那次成功 build 导出）：

```json
{
  "format": "hypit.cli-get@1",
  "build": "bld_20260914T043459227Z_E0B178D4A9",
  "output": "case-creatify-media.media",
  "type": "@hypit/media@1/SynchronizedMedia",
  "kind": "composite",
  "path": "...\get-out\creatify"
}
```

`kind` 为 `composite` 时 `path` 是一个目录，里面 `value.json` + `files/`：

```json
{ "format": "hypit.result-value@1",
  "value": { "timeline": { "frameCount": 301, "frameRate": { "numerator": 30, "denominator": 1 } },
             "visual": { "artifact": null, "height": 1280, "width": 720 } },
  "resources": [ { "at": ["visual","artifact"], "file": { "kind": "build-file", ... } } ] }
```

导出的 `files/file-0002.mp4`（2,473,858 字节）ffprobe 正常：`duration=10.033008`，
`h264 720x1280 avg_frame_rate=30/1`。**可播放 mp4 这项因此成立，但要说清楚**：
它是把已有 Output 导出来的，不是本机新渲染出来的。本机新渲染见下。

### 本机渲染不通 —— Phase 6 的已知阻塞

Phase 0 的验收要"最小 Run 产出一个可播放 mp4"。本机三次尝试，本地渲染路径两次失败、
形态还不一样：

| 尝试 | 载体                                                    | 结果                                                                                           |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | `spike-one-part.svrun`（900 帧，`export-part-1.video`） | 渲染 900 帧全部完成，编码后校验失败：`Rendered visual frame rate differs from its document`    |
| 1b   | 同上，原样重跑一次                                      | **同一错误逐字复现**（build `bld_20260920T013427044Z_62A6539AA7`），说明是确定性失败，不是偶发 |
| 2    | `render.svrun`（4112 帧，example 自带、未经修改）       | 跑到 3489/4112 帧时 CLI 崩：`Bad escaped character in JSON at position 144439`                 |
| 3    | `get` 导出已有 Output                                   | 成功，见上                                                                                     |

排查到的事实：

- **不是 ffmpeg 的问题。** hyperframes 的编码命令是
  `ffmpeg -framerate <num>/<den> -i %09d.png -frames:v <n> -an -c:v libx264 -crf 23 -preset medium -pix_fmt yuv420p -movflags +faststart`
  （`provider-hyperframes-local/src/capture.ts:256`）。用本机 ffmpeg 原样复现三组
  （90 帧 / 900 帧 / 1 帧，全 30/1 输入），ffprobe 回来都是 `avg_frame_rate = 30/1`，与文档一致。
- **不是我改坏了 run。** `spike-one-part.svrun` 保留的 `export-part-1.video` 是
  `export-parts.svrun` 里本来就有的合法 target；plan 对它解析正常，`preflight.ok = true`、
  `diagnosticCount = 0`，`needs` 报的正是 `1080x1920 / 0-900 帧 / 30/1`。
- **校验点在** `provider-hyperframes-local/src/output.ts:69-70`：对产物跑
  `ffprobe -count_frames`，把 `avg_frame_rate ?? r_frame_rate` 和 `document.frameRate` 做有理数相等比较。
- 执行日志里有一条编码开始前的 stdout：`[HyperFrames] render runtime fps [object Object]`，
  另有 GPU 探测行 `browserGpuMode probe → hardware (ANGLE, NVIDIA GeForce RTX 5060 Ti, D3D11)`。
  日志落盘时那个 `→` 变成了替换字符，说明子进程输出的 UTF-8 在管线里被按本机代码页解码过一道；
  尝试 2 的 `Bad escaped character in JSON` 很可能同源（144 KB 的单行 JSON 里混进了未转义内容）。

**对 Clone Studio 的影响**：本地渲染是 REQ-006 出片的必经路径，现在这台机器上跑不通。
Phase 6 开工前必须先解掉，否则出片链路整条不可用。它不阻塞 Phase 1-3（那三阶段不碰渲染）。
下一步该查的方向：拿到编码产物本身 ffprobe（确认 `avg_frame_rate` 实际是多少）、
以及子进程输出的编码问题是不是由本机 ANSI 代码页引起。

#### 2026-09-23 复测：两种失败都不再复现

同一台机器、同一份 spike 工作区（`X:\workflow\_spike-hypit\complex-explainer`）、同一条命令
（`hypit build <run> --runtime ../../hypit.runtime.json --follow --json`，workers 1），本地渲染两次都成功：

| build | 目标 | 结果 | 导出后 ffprobe |
| ----- | ---- | ---- | -------------- |
| `bld_20260923T090202973Z_FFE1F434A7` | `spike-one-part.svrun` → `export-part-1.video`（900 帧） | `outcome: complete`，8 分钟 | h264 1080×1920，`avg_frame_rate=30/1`，`nb_read_frames=900`，30.000s；aac 30.000s |
| `bld_20260923T091136120Z_E2D63369F6` | `render.svrun` → `complete-film.video`（4112 帧） | `outcome: complete`，26 分钟 | h264 1080×1920，`avg_frame_rate=30/1`，`nb_read_frames=4112`，137.067s；aac 137.066s |

排查过、已排除的：

- **环境没变。** ffmpeg / ffprobe 仍是 `C:\ffmpeg\bin` 下 2026-01-19 的 gyan 版（PATH 上只有这一份）；NVIDIA 驱动 32.0.15.9186（2026-01-20）；
  系统补丁最近一次 2025-11；`hypit-main` 1212 个文件全部是 2026-09-19 07:14 解压的、版本仍是 0.2.6（比 09-20 的失败还早）。
- **两次运行的渲染配置一模一样。** 对比 `.hypit/results/<日期>/<build>/execution.jsonl`：都是
  `Capture: opaque fast PNG; fixed workers 1`、`GPU hardware`、同一个 chrome-headless-shell、`quality standard; encoder ffmpeg`，
  截帧耗时也相当（PNG 175s vs 164s）。区别只在编码之后那一步：09-20 报帧率不一致，09-23 `encoding and verifying video: 17871 ms` 通过。
- **`[HyperFrames] render runtime fps [object Object]` 不是 fps 传错。** 这行是 `@hyperframes/core@0.7.101` 浏览器运行时里
  `console.info("[hyperframes] render runtime fps", { canonicalFps, source, … })` 打的一个对象，转到 Node 日志时被字符串化成 `[object Object]`。
- **「子进程输出被 GBK 解码」与帧率失败无关。** 原始 `execution.jsonl` 里的 `→` 完好（UTF-8）；之前看到的替换字符出在当时查看日志的那条管线上。

09-20 那天其实连着出了四次失败，不止两次（`.hypit/results/2026-09-20/`）：三次 `Rendered visual frame rate differs from its document`
（`export-part-1` 两次、`complete-film` 一次），一次 `Page.captureScreenshot timed out`；另有一次 CLI 进程自己崩在
`Bad escaped character in JSON`（没有留下 build 结果）。同一段时间里多种不同的渲染失败、同样的软件三天后全部通过——
更像当时机器的运行状态（Phase 0 记过可用内存只有约 4.7 GB、同时在跑生视频测试），而不是代码或编码上的确定性缺陷。
**这是推断，不是证实**：09-20 的失败只留下了一句报错，没有产物、没有 ffprobe 实测值、也没有当时的内存 / 显存读数，根因无法再定位。

**结论**：本地渲染在本机可用，「阻塞 Phase 6」解除，改记为偶发风险。Phase 6 的出片执行器要：失败原文完整展示并可「重试出片」；
渲染并发保持 1、别和其它重负载同时跑；失败时顺手记下当时的可用内存，下次再出现就有数据可查。

### Q-003 结论：不成立

**估价拿不到可用数字。** 全部联网 Provider 声明的 pricing 都只是一个价格页链接，没有任何结构化费率：

```
$ grep -rn "pricing: {" hypit-main/packages/*/src/*.ts
provider-tokendance/src/provider.ts:259:    pricing: { kind: "page", url: "https://tokendance.space/models" },
provider-hypihub/src/provider.ts:602:    pricing: { kind: "page", url: "https://hypit.ai/commercial/pricing/" },
provider-hiapi/src/provider.ts:206:    pricing: { kind: "page", url: "https://www.hiapi.ai/en/pricing" },
provider-monid/src/provider.ts:249:    pricing: { kind: "page", url: "https://monid.ai/tools" },
provider-pollo/src/provider.ts:185:    pricing: { kind: "page", url: "https://api.pollo.ai/pricing" },
provider-hyperframes-local/src/provider.ts:36:    pricing: { kind: "local" },
provider-media-local/src/provider.ts:83:    pricing: { kind: "local" },
provider-image-opencv-local/src/provider.ts:101:    pricing: { kind: "local" },
provider-whisperx-local/src/provider.ts:127:    pricing: { kind: "local" },
```

即 `pricing.kind` 只有 `"page"`（给一个 URL）和 `"local"`（零价）两种。Hypit 官方文档也写死了这一点：

> Use the stated units and conditions together with authored duration, resolution, count, or other billing facts to calculate and explain the expected cost. … **Hypit itself calculates no total.**
> —— `hypit-main/skills/hypit/references/production/builds.md:118-121`

**实际花费也拿不到。** 全仓库没有任何金额字段——`grep -rn "\bcost\b|usdCost|amountUsd|totalCost" hypit-main/packages/*/src/*.ts` 只命中 `speech-alignment` 的对齐代价函数，与钱无关。Result 里与付费相关的只有回执，且回执不含金额：

```
hypit-main/packages/build-result/src/types.ts:186:
  readonly receipt?: { readonly id: string; readonly url?: string };
```

**对 Clone Studio 的影响**：

1. REQ-006 的估价闸门不能依赖 hypit 出数。Clone Studio 必须自己维护一张"模型 → 单价"的费率表，用 `plan` 的 `needs[].summary.fields`（分辨率、帧数、时长、请求数）自己算估价，并把 `pricing` 给出的价格页 URL 展示给用户做人工核对。
2. REQ-009 的花费台账同理：实际花费只能由 Clone Studio 按"请求数 × 自己维护的单价"记账，标注为估算而非账单。
3. Spec Q-003 的兜底方案"拿不到则全部走人工确认"成立，应转为正式决定。

---

## 验证二：Claude Agent SDK 订阅登录下的行为（解 ASM-002）

**ASM-002 原文**：订阅登录下 SDK 仍返回可用的 `total_cost_usd` 供 $5 熔断使用。

SDK 版本 `@anthropic-ai/claude-agent-sdk@0.3.278`，模型 `claude-haiku-4-5`（只验机制，字段行为与模型无关），未设置 `ANTHROPIC_API_KEY`，走本机 Claude Code 的订阅登录凭据。复跑脚本见 `clone-studio/scripts/spike-agent.mjs`，五组对照。

### 结论 1：`total_cost_usd` 有值 —— 成立

每组的 `result` 消息都带真实数值，类型 `number`：

| 组                        | total_cost_usd | num_turns |
| ------------------------- | -------------- | --------- |
| A 继承本机设置            | 0.0193273      | 2         |
| B SDK 隔离 + default 模式 | 0.014272       | 2         |
| C 隔离 + 禁 Bash          | 0.0479008      | 1         |
| D resume C 会话           | 0.0518467      | 1         |

`modelUsage` 同时给出按模型分组的用量，键为 `["claude-haiku-4-5-20251001", "claude-haiku-4-5"]`。SDK 类型定义对该字段的说明：

> Cumulative estimated cost in USD for this query() call … a resumed or forked session continues from the total its transcript saved … **An estimate, not a billing statement.**

D 组花费 0.0518 > C 组 0.0479，与"resume 续上转录里保存的累计值"一致 —— 读最新一条 result 即可，**不能跨 result 累加**。

**$5 熔断可以成立**，且 SDK 自带更好的办法：`maxBudgetUsd` 选项 + `error_max_budget_usd` 结果子类型，不必自己累加判断。

### 结论 2：`canUseTool` 拦不住 Bash —— 不成立，需要换机制

这是本次验证最重要的发现。五组对照的实测结果：

| 组  | 配置                                               | canUseTool 被调用 | Bash 是否执行  |
| --- | -------------------------------------------------- | ----------------- | -------------- |
| A   | 默认（继承 `~/.claude` 设置与 hooks）              | 否                | **执行了**     |
| B   | `settingSources: []` + `permissionMode: 'default'` | 否                | **执行了**     |
| C   | B + `disallowedTools: ["Bash"]`                    | 否                | **仍然执行了** |
| E   | B + `disallowedTools: ["Bash", "Task"]`            | 否                | 未执行 ✅      |

三条事实：

1. **默认配置下 `canUseTool` 根本不会被调用。** SDK 类型定义里 `sandbox.autoAllowBashIfSandboxed` 默认为 `true` —— 沙箱内的 Bash 命令自动放行，不走许可流程；`permissionMode` 还有一个 `'auto'` 档由服务端分类器判低风险直接放行。A 组的消息流里出现 `system:hook_started`，证明不传 `settingSources` 时会连本机 hooks 一起继承。
2. **只禁 `Bash` 会被 `Task` 绕开。** C 组消息流里出现 `system:task_started` 与 `system:background_tasks_changed`，模型派了一个 Task 子 Agent 去执行命令，最终仍回报"命令成功执行，输出结果是 hello-from-spike"。`disallowedTools` 只作用于主循环的工具列表。
3. **`disallowedTools: ["Bash", "Task"]` 才真正拦住。** E 组模型明确回答"工具列表里找不到 Bash"，消息流无 task 事件，命令没有执行。但 `permission_denials` 仍为空数组 —— 这种方式是把工具从列表里**隐藏**，不产生拒绝记录。

**对 Clone Studio 的影响**：

- REQ-003 的 Agent 任务运行器必须显式传 `settingSources: []`，否则会继承用户本机的 `~/.claude` 权限规则与 hooks，行为不可预测、不可复现。
- 工具限制必须用 `disallowedTools` 白/黑名单，且**任何禁用清单都要把 `Task` 一起禁掉**，否则模型会派子 Agent 绕开。不能把 `canUseTool` 当作唯一的拦截手段。
- 抽屉里要展示"拦截"时，不能依赖 `permission_denials`（隐藏工具时为空），要么自己在 `canUseTool` 里记录，要么记录工具清单本身的限制。

### 结论 3：`resume` 可用 —— 成立

D 组用 C 组返回的 `session_id` 恢复会话，提问"我上一条消息让你运行的命令是什么"，回答 "你让我运行的命令是 `echo hello-from-spike`"，上下文正确续上，`system:init` 返回同一个 session_id。

### 消息流的真实形状

一次会话按顺序出现的消息类型（B 组，隔离模式）：

```
system:init → rate_limit_event → system:thinking_tokens ×N → assistant ×N
→ user（工具结果）→ assistant ×N → result:success
```

继承本机设置时（A 组）额外多出 `system:hook_started` / `system:hook_response`。派子 Agent 时（C 组）多出 `system:background_tasks_changed` / `system:task_started` / `system:task_updated` / `system:task_notification`，并且**会出现第二个 `system:init` 和第二条 `result:success`**。

`result` 消息的可用字段：`subtype`（`success` / `error_during_execution` / `error_max_turns` / `error_max_budget_usd` / `error_max_structured_output_retries`）、`is_error`、`num_turns`、`total_cost_usd`、`usage`、`modelUsage`、`permission_denials`、`result`（文本）、`stop_reason`。

`canUseTool` 的真实签名（取自 `sdk.d.ts:213`，与网络上的部分文档不一致，以此为准）：

```typescript
type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
}) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; ... }
  | { behavior: 'deny'; message: string; interrupt?: boolean; ... };
```

---

## 验证三：Codex 订阅生图（REQ-011）

Codex CLI `codex-cli 0.153.4`（≥ 0.128 ✅），`~/.codex/auth.json` 存在（9 月 11 日）✅。

按 Spec REQ-011 的参数数组实跑一次：

```bash
codex exec --ignore-user-config --json --ephemeral \
  -c windows.sandbox="elevated" --sandbox workspace-write --skip-git-repo-check \
  -C <临时工作目录> \
  -- "Generate one image with $imagegen: a flat-design blue circle centered on a white background. Copy the finished image to ./images/spike.png. Only generate the image; do not write, copy or modify any other files."
```

**结果：成立。** 退出码 0，产物 `./images/spike.png` 838,236 字节，文件头 `89 50 4e 47 0d 0a 1a 0a`（有效 PNG）。

Spec 描述的两条找图路径**都成立**：

- `<cwd>/images/spike.png` —— 838,236 字节
- `~/.codex/generated_images/01a0bc34-655a-7443-8545-46ae0754b07d/exec-e8707702-7875-4fa9-87b1-307832c361fa.png` —— 同样 838,236 字节

thread_id 确实取自 JSONL 首条事件：`{"type":"thread.started","thread_id":"01a0bc34-655a-7443-8545-46ae0754b07d"}`。

### JSONL 事件的真实形状

```
{"type":"thread.started","thread_id":"..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"...","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"...","aggregated_output":"...","exit_code":0,"status":"completed"}}
{"type":"turn.completed","usage":{"input_tokens":87692,"cached_input_tokens":71296,"cache_write_input_tokens":0,"output_tokens":370,"reasoning_output_tokens":0}}
```

失败判定的依据齐全：`item.completed` 带 `exit_code` 与 `status`，`turn.completed` 带 usage。Spec 说的"JSONL 出现 `error` 事件即失败"本次未触发，未验证到该事件的真实形状。

### 与 Spec 的两处出入

1. **不是 `gpt-image-2`（未验证）。** Codex 走的是内置 `image_gen` 工具，而非 CLI fallback。`~/.codex/skills/.system/imagegen/SKILL.md` 写明：内置工具模式是默认且不需要 `OPENAI_API_KEY`；`gpt-image-2` 是 **CLI fallback 的默认模型**。本次输出里没有任何字段暴露内置路径实际用的模型，所以 Spec REQ-011 "由提示词里的 `$imagegen`（底层 gpt-image-2）出图"中的括号部分应标【未验证】。
2. **每次生图有固定 token 开销。** 本次 `input_tokens: 87692`（其中 71,296 命中缓存），因为 Codex 会先读一遍 `imagegen/SKILL.md` 再干活。一图一进程的做法下，这个开销每张图都要付一次。不影响"美元计价 $0"，但影响单张耗时。
3. **内置模式的保存路径不可指定。** SKILL.md 明确："Do not describe or rely on a destination-path argument on the built-in `image_gen` tool. If a specific location is needed, generate first and then move or copy the selected output." 实测 Codex 正是先生成到 `$CODEX_HOME/generated_images/` 再用一条 PowerShell 命令复制到 `./images/`。这意味着 **Provider 的 `--sandbox workspace-write` 不能收紧到禁止执行命令**，否则拿不到图。
