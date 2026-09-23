# ADR-001 · 以「挂接 OpenCode Harness 扩展面」为改造边界，不做 fork 改写

- 状态：已决（pending thinker review）
- 日期：2026-09-22

## 背景

项目要求在 OpenCode Agent Harness 上做最小侵入式改造：保留 TUI、上下文管理、文件与 Shell 工具、Git、权限、Subagent 机制；在此之上加入四层解耦与六维调度。改造方式有两条路：(a) fork 上游直接改写内部代码；(b) 在 Harness 的公开扩展面（provider/model 解析、工具注册、配置加载、Subagent 配置、事件流）上挂载新模块。

## 决策

选 (b)。FreeCode 新增模块全部落在独立目录 `src/freecode/`，对 Harness 的触碰限定在 4 个挂接点 P1~P4（见 01 文档 §5），每个点有独立开关与回退方案，另有总开关 `freecode.harness=vanilla`。

## 理由

- 上游同步成本：fork 改写会在每次上游更新时产生合并冲突，且回归面不可控；挂接点在公开扩展面上，patch 数量恒定（4 个），回归面可枚举。
- 可回退性：任何挂接点可单独摘除，vanilla 模式保证「永远有一个能跑的 Harness 原生形态」作为事故兜底。
- 验收边界清晰：thinker 审核时只需验证「改动是否都在 P1~P4 清单内」。

## 风险与对策

- 风险：若 Harness 扩展面不满足需求（如 E1 的 provider 解析链路实际不可插拔），被迫扩大侵入面。
- 对策：core-dev 在实现首周完成扩展面核对（01 文档 §7 已知限制），发现不符即回填 issue 并触发 ADR-001 修订评审，而不是就地散改。
