# ADR-003 · 六维调度：加权归一评分 + 状态机 + 会话粘性路由

- 状态：已决（pending thinker review）
- 日期：2026-09-22

## 决策

1. **能力/特性为硬约束**（03 §2），不满足即出池；六维中 capability 保留「档位裕度」软项。
2. **总分 = Σ dᵢ·wᵢ·d，缺省权重** capability 0.25 / quota 0.20 / health 0.25 / latency 0.15 / reliability 0.10 / cost 0.05（可用户覆盖，自动归一化）。cost 权重刻意最小：可用性优先于省钱，成本只做平手 tie-break。
3. **候选级状态机**（HEALTHY / DEGRADED / UNHEALTHY / EXHAUSTED / INVALID / UNAVAILABLE，03 §4.1），事件驱动：探针结果 + 真实调用结果；provider 级状态为聚合派生，仅用于展示。
4. **会话粘性路由**（03 §4.2）：当前绑定在「top1 − 0.10」以内不换绑，保护上下文一致性；手动 override 为终态。
5. **动态指标算法**：latency EWMA（α=0.3），reliability 滑窗（1h ∩ 100 次）拉普拉斯平滑，小样本先验 0.9。
6. 全部决策写入审计日志（滚动 500 条），`/scheduler explain` 可重放。

## 理由

- 状态放候选级而非 provider 级：多账号场景下单账号故障不应拖垮整厂（02 §5 的 provider 降级为派生展示）。
- 粘性路由：无粘性时等价资源间跳变会破坏 provider 侧 prefix cache / 一致性，且 TUI 噪音大。
- 审计日志：验收要求「决策可审计」，且是调试「为什么这次选了 X」的唯一可靠手段。

## 后果 / 待验证

- 权重缺省值未经验证：实现后由 qa 用厂商实测数据回放校准（qa 子任务含「权重标定」）。
- EPS=0.02 与 STICKY_DELTA=0.10 是缺省常数，留作运行时配置项（`scheduler.tieEps` / `scheduler.stickyDelta`），标定后可调。

## 标定结果回填约定（本次修订 ⑤）

本节回填 FREE-18 的权重标定数据（qa 于 2026-09-23 10:03 UTC 交付，评论 `01a0cdb8`，见本 ADR 上方引用的标定段落），作为「缺省常数是否成立」的判定依据：

| 缺省常数 | 标定结论 | 与文档缺省值 diff |
| --- | --- | --- |
| EPS=0.02 | **维持**。先验差 200ms（zhipu vs minimax，latency 项差 ≈0.004）落入抖动区间 → jitter tie-break；差 1200ms（vs ollama ≈0.0225）出区间 → 决定性选择。恰好把同量级先验差异归入抖动，与 8s 预算自洽。 | 0 |
| STICKY_DELTA=0.10 | **维持**。当前绑定 P50 落后 winner 500/1000/4000ms 均 KEEP；P50 打到 8000ms（latency 项归 0）才 SWITCH，等价于「P50 超 4~5s 才让位」。 | 0 |
| 缺省权重 `{cap .25, quota .20, health .25, lat .15, rel .10, cost .05}` | 冷启动先验下自洽：5 厂商冷启动池选 `minimax/abab-6.5s-chat`（score 0.9712），符合「无历史不选陌生贵档」。成本项（¥2/Mtok vs 免费，weight 0.05）影响 ≤0.05，印证「成本只做 tie-break」。 | 0 |

**回填约定**（供后续修订复用）：
1. 每次权重 / 常数标定后，在 FREE-18 对应评论里落「数值 + 与文档缺省值的 diff + 回放脚本路径」（本次脚本 `qa-artifacts/wt-calib/calibrate.ts`）。
2. 若 diff 非零：先更新本 ADR 与 03 §3 的缺省值，再改实现，保持文档↔代码↔标定三方一致；diff 为零则仅在本节登记结论，不动缺省值。
3. 本 ADR「后果/待验证」中「权重缺省值未经验证」一项，随本次回填标记为**已验证**（结论：维持缺省，diff 为零）。
