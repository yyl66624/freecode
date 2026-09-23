# ADR-002 · 四层解耦模型：Agent / Provider / Model / Account

- 状态：已决（pending thinker review）
- 日期：2026-09-22

## 决策

资源寻址拆为四层，职责与不变式见 02 文档 §1：

1. **Agent**（任务角色）只声明 `CapabilityTier` + 必需特性，不感知 provider/model 具体值；
2. **Provider**（接入规范）只描述 endpoint/协议/鉴权/健康探针，不含业务语义；
3. **Model**（能力档位）静态元数据：context window、特性、tier、单价；
4. **Account**（凭据与配额）凭据以引用（keychain/env）存储，不写明文；配额与并发上限归 Account。

调度输出是 `(model, account)` 绑定（`ResourceBinding`），切换/降级语义见 02 文档 §5。

## 理由

- 单一模型寻址（`provider/model`）在「多账号轮转 / 配额耗尽 / 多厂商降级」场景下全部失效：必须把凭据（Account）与能力（Model）分开才能独立失效、独立恢复。
- Agent 只出「需求」不出「选择」，是让 Subagent 机制（保留资产）不被资源细节污染的关键不变式，也是 07 文档的依赖约束基础。

## 后果

- 配置面变大：用户要理解 4 类配置对象；对策是内置 provider 模板（02 §3）让常见厂商「填 key 即用」，四层只在高级场景暴露。
- 每层 schema 校验 + `freecode doctor` 体检是必须的（实现子任务含 schema + doctor）。
