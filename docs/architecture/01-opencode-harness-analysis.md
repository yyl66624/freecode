# OpenCode Agent Harness 现状梳理与最小侵入改造边界

> 本文档是 FreeCode 对 OpenCode Agent Harness 做改造的边界依据。所有侵入点必须列入 §5 清单并附理由与回退方案；清单之外的改动需先补 ADR。
>
> **修订说明（FREE-2 打回修复 ①）**：本文档 §3 扩展面与 §5 侵入点章节已对照本地 `opencode-dev`（HEAD `6da72b8`，分支 `freecode-main`）实际代码重写，不再基于公开文档抽象。文中代码引用均给出具体文件与行号，可供 thinker 复现核对。

## 1. 结论速览

- OpenCode Harness 的核心（TUI、上下文管理、工具执行、权限、Subagent）是**保留**资产，FreeCode 只在它定义的扩展面上做挂载，不改写其内部实现。
- FreeCode 新增的所有能力（四层模型、六维调度、国产厂商对接）以**插件模块**形式落在 `packages/opencode/src/freecode/` 与 `packages/tui/src/feature-plugins/system/freecode.tsx`，通过 Harness 的 `Provider.getModel` 唯一 seam 注入。
- 侵入点共 **4 个**（P1~P4），均为「替换默认行为」而非「删除/重写」，可单点回退（见 §5 每个点的回退方案与 `freecode.harness=vanilla` / `freecode.commands.disable` 总开关）。

## 2. 必须保留的机制（改造禁区）

| 机制 | 说明 | 保留理由 |
| --- | --- | --- |
| TUI 交互层 | 终端 UI、会话视图、消息流、权限确认弹窗 | 用户基本体验；FreeCode 的 TUI 增强（`/models`、`/why`、`/provider status`、`/account`）只做**新增命令**，经 `feature-plugins` 注册，不改既有渲染 |
| 上下文管理 | 会话历史、压缩/裁剪、项目上下文装配 | 与模型无关的核心能力；调度器只决定「发给谁」，不改变上下文内容 |
| 文件与 Shell 工具 | 读/写文件、命令执行及其沙箱语义 | 工具契约是 Subagent 与 TUI 的公共基础，改动会全链路回归 |
| Git 集成 | 仓库感知、diff、commit 辅助 | 保持 Harness 原生行为 |
| 权限模型 | 工具/命令的 allow/ask/deny 策略 | 安全边界；FreeCode 的 provider 凭据不进入该模型（见 02 文档 §3.4） |
| Subagent 机制 | 子代理派生、任务分派、结果回收 | 多 Agent 协作骨架；FreeCode 的 Agent 层直接挂载其上，不改派生协议 |

## 3. 现有扩展点（对照实际代码）

> 以下每个扩展点都标注了 `opencode-dev` 中的实际落地位置。实现者核对代码时以这些文件为准。

| # | 扩展点 | 实际代码位置 | FreeCode 用法 |
| --- | --- | --- | --- |
| E1 | LLM 寻址唯一 seam | `packages/opencode/src/provider/provider.ts:1935`（`getModel` 内调用 `FreeCodeRoute.auto`） | 这是 Harness 中「provider/model 引用变成已注册模型」的唯一位置。FreeCode 在此挂接，把「静态 provider」替换为「动态调度后的 model」 |
| E2 | TUI 自定义命令 | `packages/tui/src/feature-plugins/system/freecode.tsx`（经 `api.keymap.registerLayer` 注册命令层） | 注册 `/models`、`/why`、`/provider status`、`/account` 等命令；命令数据只读 `state.json` 与 `last-route.json` 两个 JSON 文件（见 E4） |
| E3 | 配置加载 | `packages/opencode/src/freecode/layers/config.ts`、`layers/store.ts`（`ResourceStore`） | 加载 `~/.freecode/config.json` 与 `.freecode/config.json`；`ResourceStore` 注册 Provider/Model/Account |
| E4 | 决策审计与状态落盘 | `packages/opencode/src/freecode/decision.ts`（`last-route.json`，`decision.ts:63`）、`core/state-store.ts`（`state.json`）、`core/metrics.ts` | 调度遥测（延迟、成功/失败、用量、成本）写 `state.json`；每次路由决策写 `last-route.json`；TUI 命令读这两个文件，不跨包 import |
| E5 | Subagent 派生模型注入 | `packages/opencode/src/freecode/route.ts`（`isSentinel` 接受 `freecode/auto` 与 `freecode` + 空 modelID 两种形态） | 子代理的 model 经 session 以 `ModelRef` 回传，`auto` 不是已注册模型会被丢弃为空 modelID；FreeCode 在 seam 处接受该形态并按任务 tier 重新解析 |

## 4. 能力对照：保留 vs 新增

| 能力 | Harness 现状 | FreeCode 动作 |
| --- | --- | --- |
| LLM 寻址 | `getModel` 直接 `lookup(providerID, modelID)` | **新增**：四层解耦 + 六维调度，经 E1 seam 替换静态寻址 |
| 国产厂商（MiniMax/GLM/Kimi/DeepSeek） | 无内置 | **新增**：`layers/provider-templates.json` 内置模板 + OpenAI-compatible 通道 |
| 本地模型（Ollama 等） | 部分依赖第三方 | **新增**：内置本地 provider 模板，健康检查走 HTTP ping |
| 凭据/多账号 | 单账号环境变量 | **新增**：Account 层（02 文档 §3.4） |
| 健康/配额/成本观测 | 无 | **新增**：调度器状态机（`core/state-machine.ts`）与遥测（`core/metrics.ts`） |
| TUI / 工具 / 权限 / Subagent | 完整 | **保留**，仅在 E2 feature-plugins 上新增命令 |

## 5. 侵入点清单（每处含理由与回退方案，对照实际代码）

> 判定标准：凡触碰 Harness 既有代码路径的改动都算侵入；纯新增模块与扩展点挂载不算。

### P1 · LLM 寻址替换（E1 seam）

- **实际改动**：`packages/opencode/src/provider/provider.ts:1935`，`getModel` 开头调用 `FreeCodeRoute.auto(providerID, modelID, { pool, fallback, get })`；非 sentinel 的普通 `provider/model` 走原 `lookup`，行为不变（seam 返回 `undefined` 即落回原生路径）。
- **理由**：这是「动态调度」唯一能成立的位置——`getModel` 是所有 LLM 调用的必经之路（Task 工具、agent registry、session prompt 都经此），在此替换保证调度「不可被新调用点绕过」，路由行为可从单文件审计。
- **回退方案**：`FreeCodeRoute.auto` 返回 `undefined` 时 `getModel` 落到原 `lookup(providerID, modelID)`（`provider.ts` 紧邻一行）；`freecode.harness=vanilla` 时 seam 直接返回 undefined。P1 是纯挂载，删除挂接即回退，零残留。

### P2 · Subagent 派生模型注入（E5）

- **实际改动**：`route.ts` 的 `isSentinel` 同时接受 `freecode/auto` 与 `freecode` + 空 modelID 两种形态；`resolve` 在无 routing context（子代理在父 turn 结束后自解析）时退回 `registry.fallback`（`provider.ts` 传入的 `firstAvailableModel(snapshot)`）。
- **理由**：子代理的 model 经 session 回传时 `auto` 被丢弃为空 modelID；若不在 seam 接受该形态，路由过的子代理会失败为「缺模型」。退回实例默认而非报错，既修子代理路径又不污染「缺模型」错误语义。
- **回退方案**：显式 `provider/model` 永远优先（`resolver.ts` 三段式的第一段 `fixed`）；`freecode.scheduler.disable=true` 时 P2 退化为默认模型。派生协议未改，无残留。

### P3 · 调度命令注册（E2）

- **实际改动**：`packages/tui/src/feature-plugins/system/freecode.tsx`，经 `api.keymap.registerLayer` 注册 4 个 TUI 命令：`/models`、`/why`、`/provider status`、`/account`。
- **理由**：调度透明性是验收要求（决策可审计）；feature-plugins 是 Harness 既有的「加命令」面，不改既有命令解析。命令的六维/池数据只读 `state.json` 与 `last-route.json`（不 import `@/freecode/*`），保持 tui 包与 opencode 包之间的依赖边界。
- **回退方案**：`freecode.commands.disable=true`（或 `freecode.harness=vanilla`）时插件注册**空命令层**——命令面板无条目、斜杠命令无补全、TUI 其余行为不变。整层可摘除，回到原生命令集，无残留。

### P4 · 遥测与状态落盘（E4）

- **实际改动**：`core/state-store.ts` 写 `state.json`（候选状态、EWMA、窗口计数、滚动决策日志，原子替换写入），`decision.ts` 写 `last-route.json`（完整决策审计），均落 `XDG_DATA_HOME/freecode/`；`core/metrics.ts` 在调用路径上采集延迟/成功失败/用量/成本。
- **理由**：六维中 health/latency/reliability 都是**观测**指标，必须在调用路径上采集；Harness 的 data 目录与既有 JSON 文件是现成落盘面，TUI 侧读同一组文件即打通审计闭环。
- **回退方案**：`XDG_DATA_HOME` 未设置时 state-store 纯内存运行（持久化关闭）；遥测开关 `freecode.telemetry=false`；文件写入失败降级为内存态（调度仍可用，仅冷启动状态丢失）。

### 总开关

`freecode.harness=vanilla`（或 `FREECODE_HARNESS=vanilla`；`feature-plugins/system/freecode.tsx` 的 `isDisabled` 同时接受 `commands.disable`、`harness: vanilla|true`、`scheduler.disable` 三种拼写）：跳过 P1/P2/P3/P4 全部挂载，Harness 以原生形态运行。这是最小侵入承诺的最后一道防线，也是任何回归事故的统一回退路径。

## 6. 与 OpenCode 上游的同步策略

- 以 vendored 源码 + 补丁（patch）方式管理侵入点：`opencode-dev` 即 fork 工作树，`patches/` 目录存放 P1~P4 对应 patch。
- 升级流程：拉取上游 → 重放 patch → 跑保留机制回归（TUI/工具/权限/Subagent 用例）→ 全绿后更新 vendor 版本。
- 若 patch 重放冲突：冻结当前 vendor 版本，逐侵入点写新 patch，不允许在 vendor 内直接散改。

## 7. 已知限制

- §3/§5 已对照 `opencode-dev`（HEAD `6da72b8`，分支 `freecode-main`）实际代码核对：P1 seam 现状 `FreeCodeRoute.auto` @ `provider.ts:1883~1940`、TUI feature-plugins、Bus/`state.json`/`last-route.json` 均已落地，不再有「公开文档抽象」的假设。
