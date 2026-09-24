# 四层解耦模型：Agent / Provider / Model / Account

> 四层各自独立定义、独立变更：Agent 描述「任务」，Provider 描述「谁提供推理」，Model 描述「提供什么能力」，Account 描述「用什么凭据访问」。调度器（见 03 文档）负责把任务映射到 (Model, Account) 组合。

## 1. 分层定义与不变式

```
Agent（任务角色） ──capability 需求──▶ Scheduler ──▶ (Model, Account) 绑定
                                          ▲
                        Provider（接入规范） │
                       Model（能力档位）    │
                       Account（凭据）──────┘
```

| 层 | 职责 | 不变式 |
| --- | --- | --- |
| Agent | 任务角色定义：system prompt、工具白名单、子代理组合、capability 需求档位 | 不感知 provider/model 具体值，只声明 capability 档位（§2.3） |
| Provider | 接入规范：endpoint、鉴权方式、协议（OpenAI-compatible / 本地 HTTP）、内置厂商模板 | 不感知业务任务；同一 Provider 可挂多个 Model、多个 Account |
| Model | 能力声明：context window、max output、支持特性（tools/JSON/reasoning/长文档）、capability 标签 | 能力声明是静态元数据；动态质量（延迟/可靠性）归调度器观测 |
| Account | 凭据与配额：API key、配额/预算上限、区域、并发限制 | 凭据加密落盘（keychain 或 0600 文件）；Account 失效不影响其他 Account |

## 2. 数据模型（TS 接口）

### 2.1 Agent

```ts
type CapabilityTier = "light" | "standard" | "deep" | "expert";
// light: 轻量理解/补全；standard: 常规代码修改；deep: 多文件重构；expert: 复杂架构/长上下文

interface AgentSpec {
  id: string;                        // 例: "coder", "reviewer", "tester"
  systemPrompt: string | { file: string };
  tools?: string[];                 // 白名单，缺省=全部
  capability: CapabilityTier;        // 声明需求档位，调度器据此选 Model
  subagents?: string[];             // 可派生的子 Agent id（挂载 Harness Subagent 机制）
  env?: Record<string, string>;      // 注入子进程的环境变量
}
```

### 2.2 Provider

```ts
interface ProviderSpec {
  id: string;                       // 例: "minimax", "zhipu", "moonshot", "deepseek", "openai-compat", "ollama"
  protocol: "openai-chat" | "openai-responses" | "local-http";
  endpoint: string;                 // 例: "https://api.minimaxi.com/v1/chat/completions"
  auth: "bearer" | "header:<name>" | "none";
  baseUrlOverride?: string;         // 企业网关/代理
  timeoutMs?: number;
  health?: {                       // 健康探针配置，缺省用内置
    method?: "GET" | "POST";
    path?: string;                 // 例: "/models" 或一次极简 chat 调用
    intervalSec?: number;          // 缺省 30
    failThreshold?: number;        // 连续失败判 UNHEALTHY，缺省 3
    recoveryThreshold?: number;    // 连续成功恢复，缺省 2
  };
  models: string[];                // 该 provider 下可用 model id
  accounts: string[];             // 该 provider 下可用 account id
}
```

### 2.3 Model

```ts
interface ModelSpec {
  id: string;                       // 全局唯一："<provider>/<model>"，例: "zhipu/glm-4-plus"
  provider: string;
  contextWindow: number;
  maxOutput: number;
  capabilities: string[];          // "tools" | "json" | "streaming" | "reasoning" | "vision" | "long-context"
  tier: CapabilityTier;            // 能力档位（静态，来自内置模板或用户声明）
  costPerMtok: { input: number; output: number; currency: "CNY" | "USD" }; // 缺省 0（免费/未知）
  rate?: { rpm?: number; tpm?: number };  // 官方限速（若已知）
}
```

### 2.4 Account

```ts
interface AccountSpec {
  id: string;                       // 例: "zhipu-work"
  provider: string;
  credential: string;              // 引用凭据存储键，不存明文值
  models: string[];               // 该账号可用模型子集（缺省=provider 全部）
  quota?: {
    monthlyBudgetCents?: number;   // 预算上限（分）
    monthlyBudgetUnits?: number;   // 配额上限（按厂商单位，例：次/万 token）
    window: "calendar-month" | "rolling-30d";
  };
  concurrency?: number;           // 同时并发请求上限，缺省 1
  enabled?: boolean;               // 手动开关
}
```

### 2.5 调度输出（每轮 LLM 调用生效的绑定）

```ts
interface ResourceBinding {
  model: ModelSpec;
  account: AccountSpec;
  endpoint: string;               // 由 provider + baseUrlOverride 计算
  effectiveCapabilities: string[];
}
```

## 3. 内置 provider 模板（开箱即用）

| Provider id | 厂商/通道 | 协议 | 典型模型（tier） | 备注 |
| --- | --- | --- | --- | --- |
| `minimax` | MiniMax | openai-compatible | abab-6.5s-chat（standard）；MiniMax-M1 按官方版本更新 | 需用户填 key |
| `zhipu` | GLM | openai-compatible | glm-4-flash（light，免费）；glm-4-plus（deep） | 免费档可用于无凭据冷启动（若 key 免鉴权） |
| `moonshot` | Kimi | openai-compatible | kimi-k2（deep）；kimi-k2-turbo-preview（standard） | 长上下文能力强，适合 `long-context` |
| `deepseek` | DeepSeek | openai-compatible | deepseek-chat（standard）；deepseek-reasoner（expert） | 性价比高，默认成本锚 |
| `openai-compat` | 任意 OpenAI 兼容端点 | openai-chat | 用户自声明 | 用于企业网关/自建服务 |
| `ollama` | 本地模型 | local-http | qwen2.5-coder:14b（standard）等 | 隐私场景兜底；health 走 `/api/tags` ping |

> 模板内置于 FreeCode 包中（`provider-templates.json`）；用户配置只做**覆盖与追加**，不改写模板。模型版本号会过期，模板标注「以官方为准」，用户可用 `models[]` 覆盖。

## 4. 资源解析契约（P1 挂载点，对照 `route.ts` 实际实现）

> **修订说明（FREE-2 打回修复 ②）**：本节原定义了 `ResourceResolver.resolve(req, ctx)` 契约；`opencode-dev` 现状已把它实现为 `route.ts` 的 `Route.auto(providerID, modelID, registry)` 工厂 + `resolver.ts` 的 `ModelResolver.resolve(input)` 三段式（`fixed` → `tier` → `auto`），并叠加调度器 `Scheduler.rank`。本节以现状为准重写，原接口形态作为**被取代的早期设计**保留在文末对照表，FREE-15 契约摇摆按本节的「现状 seam」口径定案。

### 4.1 现状 seam：`Route.auto`

```ts
// packages/opencode/src/freecode/route.ts
export function auto(
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  registry: Registry,
): Effect.Effect<ResolvedModel | undefined>
```

- **触发**：`getModel` 收到 sentinel 对（`freecode/auto` 或 `freecode` + 空 modelID，见 `isSentinel`）时才进入；普通 `provider/model` 引用直接走原生 `lookup`，**字节级兼容既有 OpenCode 配置**。
- **三段式语义**（`resolver.ts`）：
  1. `fixed`：`requested` 非 `auto` → 用户显式指定永远胜出，绝不二次猜测；
  2. `tier`：Agent 声明 capability 档位（`Tier = "local"|"fast"|"standard"|"strong"|"max"`，`TIERS` 弱到强有序）→ 取满足档位的最优资源；
  3. `auto`：路由器对任务分类，档位随分类结果而定。
- **选资源**：`Scheduler.rank(candidates, { tier })` 在 hard filter（tier + capability）之后做六维评分，`ranking[0]` 为胜者；胜者经 `registry.get(provider, model)` 解析成已注册模型。
- **无资格候选 / 无 routing context**：都落到 `registry.fallback`（调用方传入的 `firstAvailableModel(snapshot)`）——这是**状态而非错误**：会话保留本会使用的默认模型，不崩溃、不静默换模型。`route.ts` 在此路径仍 `Decision.write(...)` 写 `last-route.json`，保证「为什么没用上池子」也可审计。
- **seam 失败可换**：`replacementFor(failed, tier, attempts, registry)` 对已失败的那次调用做**同级 failover**（不重新分类，复用该 turn 已提交的 tier，排除刚失败的候选；见 `fallback.ts` 的 `plan`），上游 retry/halt 路径保持原样。

### 4.2 契约不变式（对 FREE-15 实现者的约束）

- 唯一入口：所有 model 决策必须经 `Route.auto`，Task 工具 / agent registry / TUI / provider 层不得各自路由（`resolver.ts` 文件头注释的不变式）。
- 类型循环规避：`ResolvedModel` 刻意是**结构化最小接口**（`id`/`providerID`/`capabilities?`/`cost?`），不 import `Provider.Model`——否则 `getModel`↔`auto` 的类型循环会塌缩成 `any`，在最重要的 seam 上静默关闭检查。实现者不得为「方便」把该接口改回 `Provider.Model`。
- 副作用收敛：`resolve` 是纯判定（分类 + 评分），副作用（写 `state.json`/`last-route.json`）集中在 `Decision.write` 与 `core/metrics.ts`，便于单测与审计重放。

### 4.3 早期设计形态（已被现状取代，仅存档）

早期草案的 `ResourceResolver`（`resolve(req: ResolveRequest, ctx: ResolveContext) → ResourceBinding`，`ResolveRequest` 含 `capability`/`requiredFeatures`/`modelOverride`）是**接口草案**，其意图已被现状吸收：

| 草案字段 | 现状对应 | 去向 |
| --- | --- | --- |
| `capability` 档位 | `resolver.ts` 的 `Tier` + `ResolveInput.tier` | 保留，改名为 `Tier`，弱到强 5 档（local/fast/standard/strong/max）取代原 4 档（light/standard/deep/expert） |
| `modelOverride` | `ResolveInput.requested`（`fixed` 段） | 保留，语义一致 |
| `requiredFeatures` | `capabilities` hard filter（`pool.ts`） | 保留，并入调度器 |
| `ctx.sessionKey`（粘性路由） | `RoutingRef`（`context.ts`）+ `sessions` 存 `state.json` | 保留 |
| 返回 `ResourceBinding` | 返回 `ResolvedModel`（结构化最小接口） | 改：不再返回 Account 实体，Account 在 `ResourceStore` 注册期解析 |

> FREE-15 实现契约以 §4.1/§4.2 现状口径为准；若需回退到草案形态（例如为多 Account 并发引入 `ResourceBinding` 返回），须先补 ADR-002 修订。

## 5. 切换与降级语义

| 场景 | 语义 |
| --- | --- |
| 手动切换（`/models` 选 model，或 `modelOverride`） | 只影响当前会话本轮起的选择；**不修改**任何配置层。切换可逆：再次执行或删掉 override 即恢复调度 |
| 调度降级（首选 model 不可用） | 自动回落到次优 (model, account)，TUI 顶部显示一行：`已降级: zhipu/glm-4-plus → deepseek/deepseek-chat（健康异常）`；决策可 `/scheduler explain` 重放 |
| Account 配额耗尽 | 该 Account 进入 `EXHAUSTED` 态（03 文档 §4.1），调度器跳过其全部模型；若该 provider 还有其他 Account 则继续，否则按降级路径 |
| Provider 整体 UNHEALTHY | 该 provider 全部模型移出候选池；连续 N 分钟（缺省 10）后自动降为 DEGRADED 候选（低权重而非剔除），避免「一次抖动永久出局」 |
| 全部不可用 | 见 03 文档 §5：CLI 打印可执行引导（配置 key / 本地模型 / 检查网络），任务挂起而非崩溃；恢复后自动继续 |
| 凭据轮换 | 新 account id 加入配置即参与调度；旧 account 标记 disabled 后从候选池移除，其历史观测保留 7 天供分析 |

## 6. 配置格式与合并规则

- **用户级** `~/.freecode/config.json`：全局默认（provider 模板覆盖、调度权重、默认 agent）。
- **项目级** `.freecode/config.json`：项目内可调度资源白名单、预算上限（企业场景防超额）。
- 合并规则：**项目级覆盖用户级，字段级深合并**；`accounts[]` 按 id 合并（项目级可 disable 某个用户级 account）。
- **凭据永不写入 config.json 明文**：`credential` 是引用（如 `keychain:zhipu-work` 或 `env:ZHIPU_API_KEY`），运行时解析。
- 配置校验：加载时做 schema 校验 + 连通性抽检（可选 `freecode doctor` 全量体检）；校验失败的条目**隔离**（打 `invalid` 标记不参与调度），不阻断启动。

## 7. 依赖方向约束

```
Agent ──▶ Scheduler ◀── Provider / Model / Account
   （Agent 只出需求）      （三层只出静态事实 + 动态观测）
```

- Agent 模块不得 import Provider/Model/Account 的具体实现，只依赖 `CapabilityTier` 与 `ResolveRequest`。
- Provider/Model/Account 模块互不 import，统一经 `ResourceStore`（配置装载器）注册。
- 该约束由 lint 规则（import 白名单）在 CI 强制（子任务见 FREE-2 拆分）。
