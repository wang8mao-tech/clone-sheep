# clone-sheep（Clone Studio）

给开源视频复刻内核 [Hypit](https://github.com/hypit-ai/hypit) 套一层本地 Web 前后端：丢进一条参考视频，无头 Agent 把它复刻成 Hypit workflow 模板，验货通过后，一句话一条变体，批量排队出片。

当前阶段：需求、设计、开发计划已完成，代码尚未开工。

| 文档 | 内容 |
|---|---|
| [Product-Spec.md](Product-Spec.md) | 产品需求（事实来源） |
| [Product-Spec-CHANGELOG.md](Product-Spec-CHANGELOG.md) | 需求变更记录 |
| [Design-Brief.md](Design-Brief.md) | 设计规范 |
| [DEV-PLAN.md](DEV-PLAN.md) | 分阶段开发计划 |
| [Hypit-Research.md](Hypit-Research.md) | Hypit 封装接口调研 |

## 准备

Hypit 不随本仓库分发。自行获取并放到根目录的 `hypit-main/`：

```bash
git clone https://github.com/hypit-ai/hypit.git hypit-main
```

Hypit 采用其自有的修改版 Apache 2.0 许可证，使用前请阅读 `hypit-main/LICENSE`。

## 密钥

本仓库不含任何密钥。运行期的 key 只存本机应用数据目录，已在 `.gitignore` 中排除。
