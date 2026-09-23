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
