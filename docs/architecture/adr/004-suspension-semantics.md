# ADR-004 · 故障兜底：SUSPENDED 挂起语义与可执行引导，而非静默失败或崩溃

- 状态：已决（**已由 `suspend.ts` 实现验证**，FREE-2 打回修复 ④）
- 日期：2026-09-22（2026-09-24 回填实现验证结论）

## 决策

当候选池为空（无可用 provider / 全部 INVALID / 配额全耗尽且无替代），LLM 调用不崩溃、不静默降级到硬编码兜底模型，而是：

1. 会话进入 **SUSPENDED** 态：上下文完整保留在会话存储中；
2. TUI 展示**可执行引导清单**（03 §5 边界表第一行）：配置 key、本地模型检查、网络检查，各附具体命令（`freecode account add`、`freecode provider test ollama` 等）；
3. 后台每 5 分钟重试探针；资源恢复后自动 resume 挂起任务（`scheduler.autoResume=true` 缺省开，用户可关）；
4. 本地模型（Ollama）是「全部云厂商挂掉」时的最后兜底路径，因其离线可用。

## 实现验证结论（本次修订 ④）

本 ADR 的语义已落进 `opencode-dev` 并验证可执行，见 `packages/opencode/src/freecode/core/suspend.ts`：

- **`park(req, now, autoResume)`**：候选池空时把任务「停放」为 `SuspendedSnapshot`，携带可重放的 `request`、可执行引导 `checklist`（三条真实命令，非「请检查网络」）、下次重试探针时间（`SUSPENDED_REPROBE_MS`，5 分钟）与 `autoResume` 开关。`DEFAULT_AUTO_RESUME = true`。
- **`reProbe(snapshot, candidates, probeOutcomes, now)`**：单次 5 分钟后台探针通过——把最新探针结果应用到候选（状态机已完成状态转移，传入的是探针后状态），问 picker 是否有可用资源；无则下一轮 5 分钟后再探，有则在选中的资源上恢复（`autoResume` 关时由 TUI 确认「继续？」）。
- **`sweepQuotaWindows(candidates, now)`**：EXHAUSTED 候选在配额窗口（日历月 / 滚动 30d）重置时被重新探活，经 DEGRADED 回到池内，对应 03 §5「配额窗口重置后自动重新探活」。

上述三条与本 ADR §决策 1–3 逐条对应：**挂起保留上下文 + 可执行引导 + 5 分钟自恢复 + 本地兜底** 的语义已在纯函数层实现并可用，TUI 计时器与会话存储归 Harness 所有（模块边界：`suspend.ts` 只产出数据，不持有副作用）。

## 理由

- 静默 fallback 到未声明模型会破坏用户对「我在用什么模型/花多少钱」的可预期性（调度透明性验收要求）；
- 崩溃丢失上下文对 coding CLI 是灾难性体验；挂起-恢复是 TUI 场景下唯一可接受的长时故障语义；
- 引导清单必须**可执行**（给出真实命令而非「请检查网络」），这是面向中国开发者冷启动的关键转化点。

## 后果

- SUSPENDED 态需要会话存储支持「任务中途挂起」：`suspend.ts` 以**纯快照 + 决策**实现（`park`/`reProbe` 均返回数据、无副作用），TUI 计时器与会话存储由 Harness 承载——挂起快照即 `SuspendedSnapshot`，经 `state.json` 的 `suspended` 段持久化，无需新增侵入点（仍落在 P4 之内）。
