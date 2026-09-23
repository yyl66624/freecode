# OpenCode Agent Harness 现状梳理与最小侵入改造边界

> 本文档是 FreeCode 对 OpenCode Agent Harness 做改造的边界依据。所有侵入点必须列入 §5 清单并附理由与回退方案；清单之外的改动需先补 ADR。

## 1. 结论速览

- OpenCode Harness 的核心（TUI、上下文管理、工具执行、权限、Subagent）是**保留**资产，FreeCode 只在它定义的扩展面上做挂载，不改写其内部实现。
- FreeCode 新增的所有能力（四层模型、六维调度、国产厂商对接）以**插件模块**形式落在新目录 `src/freecode/`，通过 Harness 公开的 provider/model 解析链路注入。
- 侵入点共 **4 个**（P1~P4），均为「替换默认行为」而非「删除/重写」，可单点回退（见 §5 每个点的回退方案与 `freecode.harness=vanilla` 总开关）。

## 2. 必须保留的机制（改造禁区）

| 机制 | 说明 | 保留理由 |
| --- | --- | --- |
| TUI 交互层 | 终端 UI、会话视图、消息流、权限确认弹窗 | 用户基本体验；FreeCode 的 TUI 增强（如 `/models`、`/provider status`）只做**新增命令**，不改既有渲染 |
| 上下文管理 | 会话历史、压缩/裁剪、项目上下文装配 | 与模型无关的核心能力；调度器只决定「发给谁」，不改变上下文内容 |
| 文件与 Shell 工具 | 读/写文件、命令执行及其沙箱语义 | 工具契约是 Subagent 与 TUI 的公共基础，改动会全链路回归 |
| Git 集成 | 仓库感知、diff、commit 辅助 | 保持 Harness 原生行为 |
| 权限模型 | 工具/命令的 allow/ask/deny 策略 | 安全边界；FreeCode 新增的 provider 凭据不进入该模型（见 §3.1 说明） |
| Subagent 机制 | 子代理派生、任务分派、结果回收 | 多 Agent 协作骨架；FreeCode 的 Agent 层（§02 文档）直接挂载在其上，不改派生协议 |

## 3. 现有扩展点（直接复用，不修改）

| # | 扩展点 | 现状 | FreeCode 用法 |
| --- | --- | --- | --- |
| E1 | Provider/Model 注册与解析链路 | Harness 以「provider ID + model ID」寻址 LLM 调用，配置来自环境/配置文件 | 在此链路上插入 FreeCode 的 `ResourceResolver`（见 02 文档 §4），把「静态 provider」替换为「动态调度后的 model/account」 |
| E2 | 工具（tool）注册接口 | 向 TUI 注入自定义命令/工具 | 注册 `/models`、`/provider status`、`/scheduler explain`、`/account add` 等 FreeCode 命令 |
| E3 | 配置加载钩子 | 用户级 + 项目级配置合并 | 加载 `~/.freecode/config.json` 与 `.freecode/config.json`（合并规则见 02 文档 §6） |
| E4 | Subagent 派生配置 | 子代理可指定 model | 派生时由调度器按任务 capability 选择 model，替换「写死默认模型」行为 |
| E5 | 日志/事件流 | 会话与工具事件可订阅 | 调度遥测（延迟、成功/失败、用量）写入事件流并落盘 `freecode.state.json` |

## 4. 能力对照：保留 vs 新增

| 能力 | Harness 现状 | FreeCode 动作 |
| --- | --- | --- |
| LLM 寻址 | 静态 provider 配置 | **新增**：四层解耦 + 六维调度（替换静态寻址，E1） |
| 国产厂商（MiniMax/GLM/Kimi/DeepSeek） | 无 | **新增**：内置 provider 模板 + OpenAI-compatible 通道 |
| 本地模型（Ollama 等） | 部分依赖第三方 | **新增**：内置本地 provider 模板，健康检查走 HTTP ping |
| 凭据/多账号 | 单账号环境变量 | **新增**：Account 层（02 文档 §3.4） |
| 健康/配额/成本观测 | 无 | **新增**：调度器状态机与遥测（03 文档） |
| TUI / 工具 / 权限 / Subagent | 完整 | **保留**，仅在 E2 上新增命令 |

## 5. 侵入点清单（每处含理由与回退方案）

> 判定标准：凡触碰 Harness 既有代码路径的改动都算侵入；纯新增模块与扩展点挂载不算。

### P1 · LLM 寻址替换（E1 链路上挂载）

- **改动**：Harness 解析 `provider/model` 时调用 FreeCode `ResourceResolver.resolve(taskSpec)`，返回具体的 `(model, account, endpoint)`。
- **理由**：这是「动态调度」唯一能成立的位置——调度发生在每次 LLM 调用前的资源解析时刻，且不改 Harness 的调用协议（入参/出参不变）。
- **回退方案**：`freecode.harness=vanilla` 或 resolver 未注册时，走 Harness 原生静态解析；P1 是纯挂载，删除挂载即回退，零残留。

### P2 · Subagent 派生模型注入（E4）

- **改动**：Subagent 派生时若未显式指定 model，则以「任务 capability 需求」调用调度器，而不是落到默认模型。
- **理由**：多 Agent 协作是项目目标；每个子任务的任务类型（理解/修改/测试/审查）天然对应不同 capability 档位。
- **回退方案**：显式 `model:` 配置永远优先于调度器；`freecode.scheduler.disable=true` 时 P2 行为退化为默认模型。派生协议未改，无残留。

### P3 · 调度命令注册（E2）

- **改动**：向 TUI 注册 4 个新命令：`/models`（查看可调度资源与当前选择）、`/provider status`（六维实时值）、`/scheduler explain <task>`（决策可解释重放）、`/account`（账号管理）。
- **理由**：调度透明性是验收要求（决策可审计）；新命令不触碰既有命令解析。
- **回退方案**：命令注册表可整体摘除（`freecode.commands.disable=true`），TUI 回到原生命令集。

### P4 · 遥测与状态落盘（E5）

- **改动**：LLM 调用结果（延迟、token、成功/失败、成本）经事件流写入 `~/.freecode/state/freecode.state.json`（滚动更新）。
- **理由**：六维中 health/latency/reliability 都是**观测**指标，必须在调用路径上采集；事件流是 Harness 现成的采集面。
- **回退方案**：遥测开关 `freecode.telemetry=false`；文件写入失败降级为内存态（调度仍可用，仅冷启动状态丢失）。

### 总开关

`freecode.harness=vanilla`（或 `FREECODE_HARNESS=vanilla`）：跳过 P1/P2/P3/P4 全部挂载，Harness 以原生形态运行。这是最小侵入承诺的最后一道防线，也是任何回归事故的统一回退路径。

## 6. 与 OpenCode 上游的同步策略

- 以 vendored 源码 + 补丁（patch）方式管理侵入点：`vendor/opencode/` 存放上游快照，`freecode-patches/` 存放 P1~P4 对应的 patch 文件。
- 升级流程：拉取上游 → 重放 patch → 跑保留机制回归（TUI/工具/权限/Subagent 用例）→ 全绿后更新 vendor 版本。
- 若 patch 重放冲突：冻结当前 vendor 版本，逐侵入点写新 patch，不允许在 vendor 内直接散改。

## 7. 已知限制（登记项，非阻塞）

- OpenCode Harness 的具体版本基线与 provider 扩展面细节待拿到可写仓库后核对（仓库当前为空、push 权限缺失，见 FREE-2 issue 状态）。本文档 §3 的 E1~E5 是**按公开文档与包内容**抽象的扩展面命名，落地实现时 core-dev 需在 issue 中回填实际函数/接口名，若与 Harness 现实不符，以 ADR-001 的评审修订为准。
