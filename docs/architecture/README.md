# FreeCode 架构总览

FreeCode 是一款面向中国开发者的轻量级多 Agent Coding CLI：用户在任意代码仓库中运行 `freecode`，即可使用自定义 Agent 手动或自动分派任务，由系统基于六维指标（capability、quota、health、latency、reliability、cost）动态选择最合适的国产 AI 模型完成任务。

本目录是 FreeCode 的架构文档体系：

| 文档 | 内容 |
| --- | --- |
| [01-opencode-harness-analysis.md](01-opencode-harness-analysis.md) | OpenCode Agent Harness 现状梳理：保留机制、扩展点、最小侵入改造边界 |
| [02-four-layer-model.md](02-four-layer-model.md) | Agent / Provider / Model / Account 四层解耦模型：接口、数据模型、配置格式、切换与降级语义 |
| [03-scheduler.md](03-scheduler.md) | 六维自动资源调度器：评分策略、状态机、边界行为、厂商对接方案 |
| [adr/](adr/) | 架构决策记录（ADR），当前已决 5 条：ADR-001 ~ ADR-005 |

## 阅读顺序

1. 先读 [01](01-opencode-harness-analysis.md) 了解改造边界与侵入点清单；
2. 再读 [02](02-four-layer-model.md) 了解四层模型与关键接口；
3. 最后读 [03](03-scheduler.md) 了解调度策略与状态机；
4. 实现任务拆分见 FREE-2 issue 评论中的子任务清单。

## 设计原则

- **最小侵入**：OpenCode Harness 的 TUI、上下文管理、文件与 Shell 工具、Git、权限、Subagent 机制一律保留；侵入点必须落入 [01](01-opencode-harness-analysis.md) 的清单并附回退方案。
- **解耦优先**：Agent 不感知 Provider 细节；Provider 不感知模型业务语义；Model 与 Account 可独立切换，调度层负责把「任务需求」映射到「当前可用资源」。
- **确定性可审计**：调度决策可重放、可打印（`/scheduler explain`），每个决策记录入 `freecode.state.json`。
- **故障可降级**：任何 provider 故障都有明确的降级路径；全部不可用时 CLI 给出可执行的引导，而不是静默失败。
