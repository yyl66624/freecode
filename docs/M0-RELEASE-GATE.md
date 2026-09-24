# M0 发布门禁与 isolated subagent 隔离契约

本文档定义 P0 冻结期的三份契约，回答 M0 需要的三个问题：

1. isolated subagent 到底保证什么？（隔离契约）
2. 什么条件下才允许打 RC？（发布门禁）
3. 冻结期内哪些改动允许做？（冻结规则）

以及一份核验结论：单一模型解析入口是否仍在位。

文档基于 `freecode-main` @ `545c435` 的代码现状撰写；所有断言与 P0-1 trace 字段、P0-2 verdict 标签一一对应，可被 `bash scripts/isolation-verdict.sh` 直接验证。

**重要**：§1.2 的断言集合是**验收锚点定义**，不是对当前 HEAD 的已跑判定结果。实际跑取与判定归 P0-8（干净 Mac 全链路），G4 依赖之；本文档不背书任何「已执行通过」的结论。

---

## 1. 隔离契约

### 1.1 名词与模式

隔离决策的唯一入口是 `packages/opencode/src/freecode/isolation.ts`（`Isolation.prepare`），
结果只有三种模式（`Isolation.Result.mode`）：

| mode | 含义 | 后续写操作落到 |
| --- | --- | --- |
| `isolated` | worktree 创建成功，subagent 的 `InstanceRef` 指向 worktree | worktree 目录 |
| `shared` | 策略性共享：agent 不写 / 声明 `workspace_mode: shared` / 无写权限 / policy 为 `never` | 共享检出（**这是契约内行为，不是缺陷**） |
| `fallback` | 想要隔离但 worktree 创建失败（非 git 仓库 / git 拒绝），降级为共享检出运行 | 共享检出（**这是降级行为，必须带 reason 记录**） |

写判定（`Worktree.shouldIsolate`）：agent 的 permission rules 未明确拒绝写即视为 writer。
该判定是保守的——误判为 writer 只多付一个 worktree 的成本；误判为 reader 会让 agent
在共享检出上与其他 writer 竞争，这是隔离要避免的事故。

### 1.2 契约断言（P0-1 trace 可验证）

trace 事件字段来自 `packages/opencode/src/freecode/trace.ts`；
verdict 标签来自 `packages/opencode/src/freecode/verdict.ts`（P0-2）。
下表每条断言都可直接映射到 trace 字段，是 P0-1/P0-2 的验收锚点。

**A. 会话层（`kind: "session"` 事件）**

| # | 断言 | trace 字段 | 判定 |
| --- | --- | --- | --- |
| A1 | 每个 subagent 会话至少有一条 `session` 记录，且 `sessionID` 与 `turn.end`/`tool.*` 事件一致。**background 追加场景**：`task.ts` 的 `background.extend`（task.ts:343）与 `task_id` resume（task.ts:141/162）会重新调用 `Isolation.prepare`，每轮产生**新的一条** `session` 记录与新的 `turn.end`；因此一个 subagent 会话在 N 次 task 调用下会有 N 条 `session` + N 条 `turn.end`。**verdict 的覆盖范围**：`decide()` 取 `events.find(kind == "session")`，即**第一条** `session` 记录；对多轮场景，verdict 反映的是第一轮的隔离判定，后续轮的写工具调用会挂回第一轮的 `worktree` 上判定（verdict.ts:120 的 `isolates[isolates.length-1]` 兜底逻辑）。**M0 契约立场**：background/resume 每轮视为新 turn，A1 的「至少一条」与 C1 的「至多一条 per task call」为当前代码事实；**代码层修复**（turn.end 带轮次/resumed 标记 + verdict 取最后一条）归 P0-4 范围，M0 文档锚点以当前行为为准。 | `sessionID` | 缺失 → verdict `ERROR` |
| A2 | `mode` ∈ {`isolated`, `shared`, `fallback`}，无第四种取值。`resumed` 字段在 `Trace.session` 签名中存在（trace.ts:127/143），但当前 `Isolation.prepare` 从未传值（isolation.ts 中所有 `Trace.session` 调用均缺失 `resumed` 参数），trace 永远 `resumed=false`。**P0-4 须修复**：`Isolation.prepare` 实传 `resumed`，使 trace 能区分首次创建与 resume 复用。 | `mode`, `resumed` | `mode` 非法值 → 实现缺陷；`resumed` 恒为 false 是已知缺口（P0-4 关闭前不影响 verdict 正确性，但影响 trace 可读性） |
| A3 | `mode=isolated` 时 `worktree` 非空且等于 `directory`；`branch` 非空 | `worktree`, `directory`, `branch` | 缺失 → worktree 创建未落盘即宣称隔离，verdict `ERROR` |
| A4 | `mode=fallback` 时 `reason` 非空 | `reason` | 缺失 → 降级无解释，属实现缺陷 |
| A5 | `mode=shared` 时 `reason` 给出策略依据（policy `never` / agent 声明 shared / 无写权限） | `reason` | 缺失 → 判读无法区分策略共享与漏判 |

**B. 工具解析层（`kind: "tool.resolve"` 事件，仅写工具 `write`/`edit`/`apply_patch`）**

| # | 断言 | trace 字段 | 判定 |
| --- | --- | --- | --- |
| B1 | `mode=isolated` 时，每次写工具的 `resolved` 路径必须位于 `session.worktree` 之内（`cwd` 即 worktree 目录） | `resolved`, `cwd` vs `session.worktree` | 违反 → verdict `WRONG_CWD`（现象 A：隔离上下文丢失） |
| B2 | `mode=shared` 或 `fallback` 时，写路径落在共享检出具 `session.directory`（策略/降级，契约内） | `resolved` vs `directory` | 落在两者之外且 `external=true` → 需外部权限放行，属用户可见行为 |
| B3 | `write` 与 `apply_patch` 的 `tool.resolve` 带 `callID`，必须有配对的 `tool.outcome`（同 `callID`）；**`edit` 工具当前 resolve 无 `callID` 传参**（edit.ts:85 缺 `callID` 字段），outcome 记录在 edit.ts:191/201 同样缺 `callID`，verdict.ts:120 以「最后一条 resolve」兜底配对——这是**实现妥协**而非契约保证，P0-4 须补 callID 并移除兜底。`shell.ts` 读类工具的 `tool.resolve`（shell.ts:616）也进 trace，但 verdict 的 `WRITE_TOOLS` 集合（write/edit/apply_patch）不含 shell，读事件不参与 verdict 判定。**M0 核验项**：`isolation-verdict.sh` 输出中若出现「兜底配对」（resolve 无 callID，outcome 无 callID，二者按最后一条 resolve 关联）须打标记，避免 P0-4 修复后把兜底误读为正确配对。 | `callID`, `outcome` | 写工具（write/apply_patch）缺失 → verdict `ERROR`；edit 兜底配对为已知限制（P0-4 关闭） |
| B4 | 以下任一情形 → `NO_WRITE`，责任方是模型/prompt 或权限系统，不是隔离代码：
（i）subagent 未调用任何写工具（`isolates.length === 0`）；
（ii）写工具 resolve 存在但所有 outcome 均非 success（`written.length === 0`，例如被 permission 拒绝或未完成）；
（iii）turn.end 为 error / 任一写工具 outcome 为 error / session 记录缺失 / mode ≠ isolated → 各自归 `ERROR`。
以上 (i)(ii) 读作模型/权限行为，非隔离缺陷；验收用例须选用能触发写工具的任务，否则 NO_WRITE 不是门禁失败。 | 写工具 `tool.resolve` 事件缺失或全部 denied | verdict `NO_WRITE`（(i)/(ii)）；`ERROR`（(iii)） |

**C. 会话终结层（`kind: "turn.end"` 事件）**

| # | 断言 | trace 字段 | 判定 |
| --- | --- | --- | --- |
| C1 | 每个 task 调用至多一条 `turn.end`；**background 追加 / resume 场景**允许多条（每轮新 task 调用产生新 turn.end，见 A1 说明）。当前 verdict 取 `events.find`，即第一条 turn.end；多轮场景下后续轮的 turn.end 对 verdict 无影响（verdict 基于第一条 session 的 `worktree` 字段）。P0-4 代码修复后 turn.end 须带轮次标记，verdict 改为取最后一条。 | `sessionID` | 首轮缺失 → verdict `ERROR`；多轮中某轮缺失 → 该轮无 turn.end 记录，属 trace 完整性缺口（P0-4 归因） |
| C2 | 主检出在整个 isolated 运行中保持不变：写工具的 `resolved` 全部在 worktree 内（即 B1 的会话级汇总） | `session.wrong`（verdict evidence） | 违反 → `WRONG_CWD`，隔离问题未关闭 |

**D. verdict 判定矩阵（P0-2，`scripts/isolation-verdict.sh` 的输出）**

| 标签 | 精确条件 | 责任方 | 是否阻塞 M0 |
| --- | --- | --- | --- |
| `OK` | 所有写解析在 worktree 内 + turn 成功 | — | 不阻塞 |
| `WRONG_CWD` | 任一写解析落到 worktree 外（含共享检出） | 隔离实现（InstanceRef/cwd 解析链） | **阻塞** |
| `NO_WRITE` | subagent 未调用任何写工具 | 模型行为（prompt/tier 选择） | 不阻塞隔离门禁，但验收用例必须改写为可触发写工具的任务 |
| `ERROR` | turn 失败 / 写工具报错 / session 记录缺失 | 运行环境或实现 | **阻塞**（需定位后重跑） |

### 1.3 降级行为（契约内，不视为缺陷）

1. 项目非 git 仓库 → `fallback` + reason「the project is not a git repository」。
2. `git worktree add` 失败 → `fallback` + reason 记录 git 报错。
3. Laya bridge 缺失 / 超时 → 路由降级为纯规则（这是**模型解析层**的降级，与隔离无关，
   但同一原则：降级必须可解释、可观测，且不得静默改变契约——路由日志必须仍产生
   `freecode route` 行）。
4. 隔离永不阻塞 subagent 启动：`fallback` 之后任务照常运行，这是显式设计，理由记录在
   `Isolation.prepare` 的注释与 DEVELOPMENT.md「Worktree isolation → Policy」。

**契约外**（以下出现即缺陷，不得在 M0 范围内静默容忍）：

- `mode=isolated` 但写路径逃逸 worktree（现象 A）；
- `session` 记录缺失、`turn.end` 缺失（trace 完整性破坏）；
- 降级/共享未记录 `reason`；
- 主检出在 isolated 运行后被改动（含 worktree 之外、`.freecode/worktrees` 目录本身除外）。

### 1.4 验收锚点命令

```sh
# 开启 trace 跑真实任务（FREECODE_TRACE=1 由 acceptance.sh 自动设置）
bun run package && bash scripts/acceptance.sh
# 对 trace 文件出判定
bash scripts/isolation-verdict.sh "$XDG_DATA_HOME/freecode/trace/<pid>.jsonl"
# 预期：每个 isolated 会话 verdict=OK；任何 WRONG_CWD / ERROR 即门禁 G2 未过
```

---

## 2. M0 发布门禁清单

每条门禁必须是**可执行命令 + 预期输出**形式，不允许「感觉 OK」。

| Gate | 内容 | 验证命令 / 动作 | 通过条件 |
| --- | --- | --- | --- |
| **G1** | 隔离缺陷修复（P0-4） | P0-4 issue 状态 `done`，且其附带的真实 provider 运行证据（≥10 次，verdict 全 `OK`） | 证据齐全 |
| **G2** | 隔离判定可复核 | `bash scripts/isolation-verdict.sh <trace>` 对 trace 中**每个含 `kind:session` 的 subagent 会话**均输出 `OK` | 所有 subagent 会话（不只是一条）均零 `WRONG_CWD`/`ERROR` |
| **G3** | stale-binary 校验生效（P0-5） | ① `bun run package` 后 binary 的 build SHA 可查（`freecode --version` 或 doctor 输出）且 == 源码 `git rev-parse --short HEAD`；② 反例：手工改 SHA 或跳过 build 直接跑验收，脚本必须失败 | ①相等；②反例失败且给出指引 |
| **G4** | 干净 Mac 全链路（P0-8） | 按 P0-8 的 11 步执行，逐步记录 pass/fail + 证据（命令 + 输出片段） | 11/11 通过；失败项须已独立成 issue 并标注阻塞/非阻塞 |
| **G5** | 安装与文档可复现（P0-6/P0-7） | 在**干净机器/干净 prefix** 上按 P0-7 文档从零执行：clone → 安装 → setup → doctor → 首任务；命令全部照做且成功 | 全链路成功；文档与 `freecode --help`/`doctor` 实际输出一致 |
| **G6** | 回归基线不劣化 | `cd packages/opencode && bun test test/config test/provider test/freecode` | fail 数 ≤ 当前基线（现有 5 个与上游基线一致的 fail）；新增 fail 必须归因 |
| **G7** | 无未评审新功能混入 | 对比 `freecode-main` 相对 `freecode-upstream-base`（`e027eb5`）的 diff：`git log --oneline e027eb5..HEAD`，每条 commit 必须 (a) 属于 P0 范围（隔离修复 / stale-binary / 文档 / 推送），或 (b) 在冻结规则 §3 允许清单内，且 (c) 已在对应 issue 评审通过 | 无第三条路径的 commit；有则打回 |
| **G8** | 单入口核验（§4） | 按 §4 检查清单执行，附结果 | 入口数 == 1 |
| **G9** | RC 产物（P0-9） | tag、构建产物 + `SHA256SUMS`；干净环境安装产物并跑通 `acceptance.sh --skip-network` | 产物可安装、SHA 可校验、离线验收通过 |

**门禁顺序**：G1→G2 依赖 P0-4 完成；G3 依赖 P0-5；G4 依赖 P1-P7；G9 在 G4 之后；
G6/G7/G8 在 G9 提交时复查一次。P0-10（thinker 放行）逐条核验 G1–G9。

**G7 核查基线补充**（thinker 评审项）：`873ffb1`（CLI 入口/TUI/doctor，+3873 行）在 `a3e1a3d` 之前已落
`freecode-main`，其 commit message 引 FREE-17/P3（非 P0 清单）。按 §3 冻结规则，它属「新 CLI 子命令 + TUI
变更」，落在「不允许」列。P0-10 执行 G7 的 `git log e027eb5..HEAD` 逐条比对时须先判定：该 commit 属**冻结规则
生效前存量**（允许保留）还是冻结期内新混入（打回）。判定标准：`873ffb1` 的时间戳若早于 P0 冻结期起点
（M0 父 issue FREE-3 创建时间 2026-09-22T15:45Z）则为存量，否则打回。本 issue 评审不为它背书，只要求在
G7 核查时把它标出来。

---

## 3. 冻结规则

**允许（P0 范围内）**：

- 修复 isolated subagent 隔离缺陷（P0-4）及其回归测试；
- stale-binary 防护（P0-5）：build SHA 注入 binary + 验收脚本校验；
- 推送仓库与复现链（P0-6）：`.gitignore` 修正、remote 配置、发布脚本的**必要**修复；
- 安装/快速开始文档（P0-7）；
- 验收脚本与 trace/verdict 工具的**缺陷修复**（非功能增强）；
- 文档更新（DEVELOPMENT.md、UPSTREAM.md、本文档）；
- 回归基线中的既有失败项归因记录（不改代码）。

**不允许**：

- 新 agent / 新 tool / 新 provider / 新 model 入口；
- 新 CLI 子命令、新配置项、新 UX 变更；
- 路由/调度策略调整（tier、权重、failure 分类）；
- 对上游 OpenCode 代码（`src/session`、`src/provider` 非 seam 部分、TUI 等）的任何改动，
  除非是隔离缺陷的**最小必要**修改且已在此文档记录理由；
- 依赖升级、锁文件大改（bun.lock 微调除外，且需说明）。

**例外申请**：

1. 提交方在**对应 P0 issue**（或 M0 父 issue FREE-3）下评论：理由 + 改动范围 + 回退方案
   （如何 revert 且不影响门禁）；
2. 由 architect 判定是否属于「最小必要」，判定结果写回评论；
3. 不阻塞 P0 主线的可选改进 → 一律记入「Not started」清单，冻结期结束后处理；
4. 人类（Mika）可否决任何判定，最终裁决归 P0-10。

---

## 4. 单一模型解析入口核验

**现状结论：入口唯一，未散落。**

- 唯一入口：`Provider.getModel` 内的 FreeCode seam（`packages/opencode/src/provider/provider.ts`，
  `getModel` 函数体中调用 `FreeCodeRoute.auto`）。注释已声明这是唯一将模型引用变为具体
  已注册模型的位置。
- `FreeCodeRoute.auto` 仅在 `provider.ts` 的 `getModel` 中被调用（`route.ts` 定义，
  `processor.ts` 调用的是 `FreeCodeRoute.replacementFor`——那是**替换已选模型**的 failover
  路径，属资源调度层，不是模型解析入口，不改变「解析」的单入口性质）。
- 调用方（Task tool、agent registry、session prompt）都通过 `Provider.getModel` 到达 seam，
  无绕过路径；`parseModel("auto")` 产生的 `freecode/auto` sentinel 与 Task tool 的空 model id
  两种形态都在 `Route.isSentinel`（`route.ts`）中被拦截。

**G8 核验清单（每次门禁时执行）**：

```sh
# 1. 调用方扫描：除 provider.ts getModel 与 processor.ts failover 外，无其它调用
grep -rn "FreeCodeRoute\." packages/opencode/src --include="*.ts"
#    预期：provider.ts → auto（解析入口，唯一）
#          processor.ts → replacementFor（failover 替换，非解析）
# 2. sentinel 拦截点唯一
grep -rn "isSentinel\|freecode/auto" packages/opencode/src --include="*.ts"
#    预期：只在 route.ts 定义/使用
# 3. 任何新增 "auto" 字符串处理或 getModel 外部解析调用 → G8 失败
```

---

## 5. 与 P0-1 trace 字段对照（速查）

```
instance  : directory, worktree, project
session   : sessionID, parentSessionID, agent, resumed, model,
            mode (isolated|shared|fallback), directory, worktree, branch,
            reason, parentDirectory, parentWorktree
tool.resolve : sessionID, messageID, callID, tool, inputPath, cwd, resolved, external
tool.outcome : sessionID, callID, tool, outcome (success|permission|error), error
turn.end   : sessionID, parentSessionID, agent, outcome (success|error), error
```

本文 §1.2 的断言 A1–A5 / B1–B4 / C1–C2 逐字段覆盖上表，
verdict 标签（OK / WRONG_CWD / NO_WRITE / ERROR）由 `verdict.ts` 的 `decide()` 实现，
并有 `packages/opencode/test/freecode/verdict.test.ts` 的样本兜底。

---

## 6. trace 覆盖缺口（已知，P0-4 关闭）

以下两条是 trace 层面的**已知缺口**，记录在此以避免 P0-4 修复隔离时把它们误读为
写证据或漏判：

1. **`edit.ts` 无 callID**：`edit` 工具的 `tool.resolve`（edit.ts:85）与
   `tool.outcome`（edit.ts:191/201）均未传 `callID`，verdict.ts:120 以「最后一条
   resolve」兜底配对。`write`（write.ts:46/80）与 `apply_patch`（apply_patch.ts:64/288）
   均带 callID，配对正确。P0-4 须补 edit 的 callID 并移除兜底逻辑。
2. **`shell.ts` 读事件进 trace**：`shell.ts:616` 的 `Trace.toolResolve` 记录的是 shell
   读类操作（`resolved` 为 shell 工作目录，非文件写目标）。verdict 的 `WRITE_TOOLS`
   集合（write/edit/apply_patch）不含 shell，故读事件不参与 verdict 判定。P0-4 修隔离
   时不应把 shell 读事件误当作写证据。

---

*文档状态：架构师初稿，待 thinker 评审。冻结期结束或 P0-10 放行后，
§3 冻结规则自动失效；§1/§2 作为长期契约保留。*
