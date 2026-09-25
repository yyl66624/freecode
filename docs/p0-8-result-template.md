# P0-8 干净 Mac 全链路 11 步验收 · 结果表模板

填写规则：
- 每行填 **结果**（pass / fail / skip）+ **证据**（该步命令最后 ≤10 行输出，或指定文件路径）+ **备注**（归因：产品缺陷 / 操作前提 / 环境；fail 项须另立独立缺陷 issue，在此写 issue 号）。
- 若本次在**开发机**（非全新 macOS）上跑：表头 `host = 非干净机器`，P0-8 只能记 done-with-caveat，真·干净 Mac 终验挂 P0-8-R 硬门（RC 对外宣告前必须过）。
- 任何 § fail 的最小复现 = 命令 + 输入 + 期望 vs 实际 + verdict / 日志，独立成 issue 指派 core-dev / cli-dev，标 阻塞 / 非阻塞（`WRONG_CWD` 与 §1 安装类 = 阻塞）。

## 环境信息块（表头必填）

| 项 | 值 |
| --- | --- |
| 机器型号 / 架构 |  |
| `sw_vers` |  |
| `host`（干净机 / 非干净机器） |  |
| VERSION |  |
| SOURCE_HEAD |  |
| BUILD_SHA |  |
| 密钥类型（deepseek / glm / kimi / minimax / ollama） |  |
| 执行日期 / 执行人 |  |

## 逐步结果表

| # | 步骤 | 结果 | 证据（命令 + 输出片段） | 备注（归因） |
| --- | --- | --- | --- | --- |
| §0 | 环境 + stale-binary 门禁 |  | `version.sh check` 输出；SOURCE_HEAD= ; BUILD_SHA= | P0-5 门禁；fail 则整表作废 |
| §1 | 安装 |  | `freecode --version` ; doctor 结尾行 | VERSION= |
| §2 | 启动（非交互） |  | `config validate` 输出 |  |
| §3 | setup Provider |  | setup / provider test / `ls -l ~/.freecode/secrets.env` | 明文泄漏 = 产品缺陷升级 |
| §4 | TUI 启动 |  | （人工）TUI 首屏截图或录屏片段 | 仅人可判 |
| §5 | Head 分派 |  | `freecode tasks` 输出；task id= |  |
| §6 | 路由可解释 |  | `freecode routes why` 全文；选定 model + tier= |  |
| §7 | worktree 隔离 |  | 主检出 `head -1`；worktree `find` 结果；verdict 标签= | WRONG_CWD = 阻塞 |
| §8 | diff / merge |  | `tasks diff/merge` 输出；合并 commit= |  |
| §9 | 退出 |  | exit code= |  |
| §10 | 会话恢复 |  | `--continue` 输出；会话 id 复用=是/否 |  |
| §11 | fallback（可选） |  | `routes status` broken 账号状态=；重试次数= |  |

## 失败项登记

| § | 最小复现（命令 + 输入 + 期望 vs 实际） | verdict / 日志 | 缺陷 issue | 阻塞? | 指派 |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  | core-dev / cli-dev |
