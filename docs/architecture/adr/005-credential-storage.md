# ADR-005 · 凭据安全：引用式存储，配置零明文

- 状态：已决（pending thinker review）
- 日期：2026-09-22

## 决策

1. `Account.credential` 是**引用**（`env:KEY_NAME` 或 `keychain:<id>` 或 `file:<path>`），永不出现明文 key；config.json 可整体提交进 git（项目级配置安全地纳入版本管理）。
2. 解析优先级：显式 `env:` 变量 > 项目级 > 用户级 keychain；缺失时该 account 标 `INVALID`（03 §5 的凭据 401/403 路径）。
3. 默认存储：macOS 走系统 keychain（`security` 命令），Linux 走 0600 的 `~/.freecode/credentials.json`（XDG 目录）；Ollama 等本地 provider 默认 `auth=none`。
4. 凭据轮换：新增 account id 即生效；旧 id 手动 disable；其观测数据保留 7 天后清理。

## 理由

- 项目级配置要进 git（团队协作），明文 key 会随仓库泄漏——这是四层模型最大的安全面，必须从格式上杜绝。
- 401/403 自动判 INVALID（03 §4.1）与引用式存储闭环：key 失效 = 该 account 出池，不影响其他 account。

## 后果

- 需要 `freecode account add` 交互式录入命令（cli-dev 子任务）；首次无 GUI 环境（CI 容器）用 `env:` 引用即可。
