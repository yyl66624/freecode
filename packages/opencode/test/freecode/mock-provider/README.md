# MockProvider — 可注入延迟/失败率/配额的 provider 测试基建

## 来源

[FREE-23](mention://issue/01a0d15f-d054-7135-a452-3b94032a7912) · `docs/architecture/03-scheduler.md` §5（docs 03 §5 即本 issue 所称 §2.3 注入矩阵）e2e 故障注入矩阵前置。

## 位置与边界

- 代码：`packages/opencode/test/freecode/mock-provider/index.ts`
- 测试：`packages/opencode/test/freecode/mock-provider.test.ts`
- **不侵入 `src/freecode/` 生产路径**。仅 `import` 真实调度核心（state-machine / metrics / scoring / scheduler-core / suspend），生产路径永远不看到 mock。

## 可注入维度

| 维度 | 参数 | 语义 |
| --- | --- | --- |
| 失败率 | `failureRate: 0..1` | `hash(seed, callIndex) < rate` 时调用失败；确定性，无 `Math.random` |
| 错误类型 | `failWith: "401" \| "403" \| "429" \| "5xx" \| "timeout" \| "connection"` | 失败时产出的故障类型；映射到真实的 `CallOutcome` / `ProbeResult` |
| 延迟分布 | `latency: { fixed?: number; range?: [lo, hi] }` | 成功路径延迟；`range` 内按调用索引确定性取值 |
| 配额上限 | `quota: { limit: number; resetAt?: number }` | 成功调用 ≤ `limit`，超出后一律 429 → EXHAUSTED；`buildCandidate` 报告剩余分数（0 → `eligible` 的 `quota-remaining` 排除） |

## 稳定接口

```ts
import { MockProvider, buildCandidate, scenarios, defaultProfile, type MockProfile } from "@test/freecode/mock-provider"

const provider = new MockProvider({ seed: 42, profiles: scenarios.cloudDown(["zhipu/glm-4-flash@zhipu-main"]) })
const pool = specs.map((s) => buildCandidate(provider, s, 3, NOW))
const outcome = SchedulerCore.resolve(pool, req, { now: NOW, jitterSeed: 0 })
```

- `MockProvider.nextCall(key)` / `nextProbe(key)` → 确定性 `CallResult` / `ProbeResult`
- `MockProvider.applyCall(key, health, metrics, now)` → 把一次调用喂给真实的 `onCall`（state-machine）+ `onCall`（metrics）
- `MockProvider.applyProbe(key, health, now)` → 真实 `onProbe`
- `MockProvider.reset()` / `clone()` → 确定性重放
- `buildCandidate(provider, spec, calls, now)` → 直接产出 `SchedulerCore.resolve` 可消费的 `Candidate`
- `scenarios` → 四个 §5 场景的一行 profile 构造器（cloudDown / ollamaFallback / quotaExhausted / invalidCredential / offline / timeout）

## 确定性

- 所有随机性来自 mulberry32 风格的确定性散列：`(seed, callIndex, streamIndex)` 三元组固定即结果固定。
- 无 `Date.now()`、无 `Math.random`、无网络 I/O。
- 两个同 seed 的 provider 产生完全相同的调用流；`reset()` 后重放同样流。

## 验收口径

- qa 可在 §5 注入矩阵中直接 `import { MockProvider, scenarios } from "@test/freecode/mock-provider"`，喂给 `SchedulerCore.resolve`。
- 同参数 + 同 seed 同结果，无 flaky。
- 既有 `bun test test/freecode` 全绿不回退（基线 273 pass / 0 fail → 新 288 pass / 0 fail，全量回归通过）。

## 遗留

- **无**。
