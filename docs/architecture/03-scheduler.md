# 六维自动资源调度器

> 六维指标：**capability（能力匹配）**、**quota（配额余量）**、**health（健康度）**、**latency（延迟）**、**reliability（可靠性）**、**cost（成本）**。本文明确定义评分公式、候选状态机、边界行为与厂商对接方案。

## 1. 候选池与指标来源

每个候选是 `(model, account)` 绑定（见 02 文档 §2.5）。指标分两类：

| 指标 | 来源 | 更新方式 |
| --- | --- | --- |
| capability / tier / features | 静态：Model 模板 + 用户配置 | 配置变更时 |
| cost | 静态：costPerMtok（模板或用户声明） | 配置变更时 |
| quota | 动态：account 配额 + 本地用量累计 | 每次调用后 + 厂商 quota API（若有） |
| health | 动态：健康探针 + 调用失败观测 | 探针周期 + 事件流 |
| latency | 动态：近期调用 P50/P95 | EWMA 滑动（§3.2） |
| reliability | 动态：近期成功率（窗口 1h / 100 次取小） | 事件流 |

## 2. capability 匹配（硬约束，先行过滤）

```
eligible(c, req) =
  c.model.tier >= req.capability          # 档位偏序: light < standard < deep < expert
  && c.requiredFeatures ⊆ c.model.capabilities   # 例: req 要 "tools" 则候选必须支持
```

不满足者直接剔除出候选池，**不参与评分**（能力不足不是「低分」而是「不可用」）。

## 3. 评分策略

### 3.1 总分公式

```
score(c) = Σ dᵢ · wᵢ·d        # 六维各自归一化到 dᵢ ∈ [0,1]，加权求和
```

缺省权重（用户可覆盖，`~/.freecode/config.json` → `scheduler.weights`，会自动归一化）：

| 维度 d | 缺省 w | 归一化定义 |
| --- | --- | --- |
| capability d₁ | 0.25 | 档位超出需求的裕度：`tier(c) - tier(req)` 映射 0/0.5/1（恰好=0，高 1 档=0.5，高 2 档=1）。裕度越大分数越低？——不：**恰好满足需求得 1**（够用最好，避免无谓贵档），低 1 档得 0.5（deep 需求用 standard 需额外惩罚见下），低于需求=0（已被 §2 过滤，不会发生）。即 `d₁ = 1 - min(1, (tier(c)-tier(req)) · 0.25)` |
| quota d₂ | 0.20 | 剩余配额比例 `remaining/budget`；无预算声明视为 1（上限未知时不惩罚） |
| health d₃ | 0.25 | 状态映射：HEALTHY=1，DEGRADED=0.5，UNHEALTHY/EXHAUSTED=0（实际已被状态机剔除，保险起见保留） |
| latency d₄ | 0.15 | `max(0, 1 - p50_ms / 8000)`（8s P50 线性衰减为 0；本地模型与云模型同公式，本地通常占优） |
| reliability d₅ | 0.10 | 近窗成功率 `1 - fail_rate`；样本 < 5 次时按 0.9 先验（给新资源机会，避免冷启动全 0） |
| cost d₆ | 0.05 | 相对成本：`1 - cost(c)/max(cost over eligible)`；全免费/全 0 时所有候选 d₆=1（不区分） |

**cost 权重刻意最小（0.05）**：能力与可用性优先于省钱，但成本在平分时做 tie-break，避免「免费但慢/弱」的资源被滥用。

### 3.2 动态指标算法

```
# 延迟（EWMA，半衰期 10 分钟）
alpha = 1 - exp(-ln2 / (10*60*req_interval))   # 缺省简化：alpha = 0.3 每次调用
p50_ewma ← p50_ewma + alpha * (observed_p50 - p50_ewma)

# 可靠性（滑动窗口：最近 1 小时且最近 100 次调用取交集）
reliability = (window_successes + 9) / (window_total + 10)   # 拉普拉斯平滑，小样本倾向 0.9

# 健康探针（03 文档外引自 02 文档 ProviderSpec.health）
连续失败 ≥ failThreshold(3) → UNHEALTHY；连续成功 ≥ recoveryThreshold(2) → HEALTHY；
介于其间 → DEGRADED
```

### 3.3 选择规则

```
pick(req):
  pool = [c in candidates if eligible(c, req) and c.state in {HEALTHY, DEGRADED}
          and c.account.enabled and c.account.quotaRemaining > 0]
  if pool 为空:
      # 二次尝试：放开 DEGRADED（若首次已含则等价）并放宽 requiredFeatures（去掉 "long-context" 降级为截断）
      pool2 = relaxed_eligible(...)
      if pool2 为空 → NoResourceError（§5）
      else 选 pool2 最优并标记 degraded_path=true
  score 全计算；top1 = argmax score
  if top1.score - top2.score < EPS(0.02):   # 平局抖动
      top1 = jittered tie-break（在 [top1, top2] 间按 latency 更优者取，仍平则按 account 并发余量）
  return sticky_route(top1, session)         # §4.2
```

## 4. 候选状态机

### 4.1 每候选 `(model, account)` 状态

```
             probe ok / 调用成功
   ┌──────────────────────────────────────┐
   │                                      ▼
 IDLE ──首次注册──▶ HEALTHY ◀──连续成功≥2──▶ DEGRADED
   │                 │  连续失败≥1(未达阈值)   │
   │                 ▼                        ▼
   │              DEGRADED  ◀─连续失败≥3──  UNHEALTHY
   │                 │                          │
   │                 └──连续成功≥2 恢复──────────┘
   │
   └──account 配额耗尽──▶ EXHAUSTED（配额窗口滚动/日历月重置，或用量清零后自动回 HEALTHY 重新探活）
   └──account.enabled=false / 凭据 401──▶ INVALID（仅凭据轮换或手动启用可恢复；不参与任何自动恢复）
```

状态转移仅由两类事件驱动：① 探针结果；② 真实调用结果（4xx 中 401/403→INVALID，429→计入 quota 与 reliability，5xx/超时→计入 health 与 latency）。**状态是候选级，不是 provider 级**——同 provider 多 account 互不影响（02 文档 §5 的「provider 整体降级」由聚合规则派生：provider 全部候选 ∉ {HEALTHY, DEGRADED} 时标记 provider=DOWN，用于 TUI 展示与 `/provider status`）。

### 4.2 会话粘性路由

```
sticky_route(top1, session):
  current = session.active_binding
  if current 仍在 pool 且 score(current) >= score(top1) - STICKY_DELTA(0.10):
      return current      # 避免同一会话在等价资源间跳变（上下文缓存/一致性收益）
  else:
      session.active_binding = top1
      emit SwitchEvent(from=current, to=top1, reason)   # TUI 显示降级/切换行
  return top1
```

`STICKY_DELTA` 缺省 0.10：只有显著更优才换。用户手动 override 的绑定不参与粘性比较（override 是终态，直到用户撤销）。

### 4.3 决策审计

每个 `resolve()` 记录一行决策日志（`state.json` 滚动 500 条）：

```json
{ "ts": "...", "task": "coder/refactor", "req": "deep+tools",
  "candidates": [{"m":"zhipu/glm-4-plus","a":"zhipu-work","score":0.83}, ...],
  "pick": "deepseek/deepseek-chat@deepseek-main", "path": "sticky", "reason": "..." }
```

`/scheduler explain <task>` 即重放最近一条（或指定 task 类型）并展示每维权重贡献。

## 5. 边界行为定义（验收口径）

| 边界 | 行为 |
| --- | --- |
| **无可用 provider**（候选池空或全部 INVALID） | 抛 `NoResourceError`；TUI 不崩溃，展示引导清单：① 配置 API key（`freecode account add`）② 检查本地模型（`freecode provider test ollama`）③ 网络/代理检查。任务进入 **SUSPENDED** 态，保留上下文，资源恢复后提示「继续执行？」 |
| **配额耗尽** | 该 account 全部候选 → EXHAUSTED；调度器自动切到次优 account（同 model 或跨 model 均可，纯按 score）；TUI 提示「zhipu-work 月配额已用完，已切到 zhipu-pool-b」。配额窗口重置（下月 1 日 0 点 / 滚动 30d）由调度器定时任务检测并触发重新探活 |
| **健康检查失败（持续）** | 候选 → UNHEALTHY 出池；provider 全灭时保持 SUSPENDED 引导不变，同时每 5 分钟后台重试探针（不阻塞 UI）；恢复后 TUI 提示并自动 resume 挂起任务（若用户确认过自动恢复，`scheduler.autoResume=true` 缺省开） |
| **健康检查本身不可达（离线/本地模型未启动）** | 探针超时计入失败但不直接判 UNHEALTHY（区分「坏了」与「没开」：连续 3 次**连接级**失败 → 候选标记 `UNAVAILABLE`，TUI 提示「Ollama 未运行？`ollama serve`」；区别于 5xx 的健康失败） |
| **成本数据缺失** | costPerMtok 缺省 0 → d₆ 全体并列，不影响选择；若候选中同时有 0 与 >0，免费者 d₆ 更高（1 vs <1），轻微偏向免费（符合「FreeCode」定位） |
| **单候选（唯一可用资源）** | 正常选中；若其 DEGRADED，TUI 明确提示「当前仅 Z 可用（延迟偏高）」，不隐藏风险 |
| **并发调用（多 subagent 同时 resolve）** | 调度器决策锁（进程内）保证同一 moment 各调用拿到一致候选池快照；account.concurrency 限制由调度器令牌桶执行（超出则排队，等待 > 2s 才换候选） |
| **凭据 401/403** | 候选 → INVALID 并停止该 account 所有调用；TUI 提示 `freecode account add <provider>` 重新录入；自动重试一次（防临时令牌过期），仍失败才判 INVALID |

## 6. 与中国厂商及本地模型的对接方案

| 厂商 | 协议 | 配额获取 | 延迟特征（缺省先验） | 备注 |
| --- | --- | --- | --- | --- |
| MiniMax | OpenAI-compatible（`/v1/chat/completions`） | 无公开 quota API → 本地用量累计 + 用户声明 budget | P50 800~1500ms | 模板内置 abab-6.5s-chat；工具调用支持按官方文档更新 |
| GLM（智谱） | OpenAI-compatible | 同上（flash 免费额度按官方规则本地估算） | P50 600~1200ms | glm-4-flash 免费档作为**无凭据冷启动**首选 |
| Kimi（Moonshot） | OpenAI-compatible | 付费档有用量接口（若可用则拉取，降级本地累计） | P50 1000~2000ms | 长上下文（128k+）是 `long-context` 特征的主要来源 |
| DeepSeek | OpenAI-compatible | 同上 | P50 1000~1800ms | 成本锚：deepseek-chat 的 costPerMtok 写入模板作为 d₆ 基准 |
| OpenAI-compatible 用户端点 | 用户声明 | 用户可声明 budget/limits | 无先验，冷启动后学习 | 校验 endpoint 可达性（`freecode provider test`） |
| Ollama / 本地 | local-http（OpenAI 兼容端点 `/v1`） | 不适用（本地无配额） | P50 视硬件，先验 2000ms | 健康检查 = `GET /api/tags`（Ollama）或 `/v1/models`；离线可用，是「全部云厂商挂掉」时的兜底路径 |

**凭据对接统一**：所有厂商 key 经 `Account.credential` 引用（env / keychain），不落 config 明文；Ollama 默认 `auth=none`。

## 7. 冷启动行为（首次运行，零历史观测）

1. 静态事实（capability/cost/quota 声明）立即可用。
2. 动态维度取**先验**：latency=厂商缺省 P50（§6 表），reliability=0.9，health=UNKNOWN→首次探针成功后转 HEALTHY。
3. 前 3 次对每个候选做**影子调用**（真实调用但 TUI 标注「采样中」），采样期权重向「低成本+高可靠性先验」倾斜，避免把用户第一次任务打到陌生贵档。
4. 30 分钟内（或 20 次调用后）进入稳态公式。

## 8. 状态持久化与恢复

- `~/.freecode/state/freecode.state.json`：候选状态、EWMA 值、窗口计数、决策日志（滚动 500）。
- 启动时加载：超过 24h 未更新的动态值视为过期 → 动态维度回先验、静态维度保留；**EXHAUSTED/INVALID 不自动过期**（配额/凭据是事实不是观测）。
- 写入失败（磁盘满/权限）：降级为纯内存态，TUI 提示一次；调度本身不中断。
