# FreeCode 安装、快速开始与故障排查（RC）

> 适用版本：v0.4.0（`934475c` 及之后）。本文档中所有命令均在 darwin-arm64 上
> 对 `934475c` 构建实跑验证；输出为真实运行结果（敏感 key 已省略）。
> 交付项：P0-7（FREE-10）+ 并入的 FREE-19 剩余章节（README 指向 / 配置手册 / 调度器用户说明）。

---

## 0. 前提

干净 Mac（macOS，Apple Silicon 或 Intel）需要：

| 依赖 | 用途 | 检查命令 |
| --- | --- | --- |
| git ≥ 2.30 | 隔离（worktree）与任务合并 | `git --version` |
| curl + tar | 安装脚本 | `curl --version` |
| bash | 安装脚本 | `bash --version` |
| bun ≥ 1.4 | 仅源码安装 / 开发需要 | `bun --version` |
| Python ≥ 3.10 | 可选，Laya 加速层 | `python3 --version` |

不装 Python 也能用：FreeCode 退化为纯规则路由（见 doctor 输出的说明）。

---

## 1. 安装

### 1.1 从源码安装（RC 推荐路径）

```bash
# 1) 克隆
git clone https://github.com/yyl66624/freecode.git
cd freecode

# 2) 安装 bun（没有的话）
curl -fsSL https://bun.sh/install | bash

# 3) 编译
bun install
cd packages/opencode
bun run package          # 产物 dist/freecode-<platform>/bin/freecode
```

实跑输出（`934475c`，darwin-arm64）：

```
$ bun run package
building freecode 0.4.0 for darwin/arm64
smoke testing dist/freecode-darwin-arm64/bin/freecode --version
  0.4.0
ok  dist/freecode-darwin-arm64/bin/freecode
next: ./install.sh
```

### 1.2 安装到本机

```bash
./scripts/install.sh
```

脚本做四件事（全部可被环境变量覆盖）：

1. 把 `freecode` 二进制放进可写目录：`$FREECODE_INSTALL_DIR` > `$XDG_BIN_DIR` > `~/bin` > `~/.freecode/bin`；
2. 安装 Laya bridge（可选加速层）到 `~/.freecode/bridge`；
3. 写起步配置 `~/.config/freecode/freecode.jsonc`（已存在则不动）与 `agents/coder.md`；
4. 准备 Laya Python venv（缺 Python 或想跳过：`FREECODE_SKIP_LAYA=1 ./scripts/install.sh`）。

安装完成输出（实跑，隔离 HOME）：

```
Done.
  FreeCode          <install_dir>/freecode
  version           0.4.0
```

若 `<install_dir>` 不在 PATH，脚本会打印一行 `echo 'export PATH="...:$PATH"' >> ~/.zshrc`。

### 1.3 确认安装成功

```bash
freecode --version      # 期望: 0.4.0
freecode doctor         # 期望: 结尾 "FreeCode is usable."
```

`doctor` 是安装后的第一道验收。完整输出解读见 §4。

### 1.4 从 release 安装（RC 发布后）

```bash
./scripts/install.sh --from-release
# 或指定版本
FREECODE_VERSION=0.4.0 ./scripts/install.sh --from-release
```

脚本会下载 `freecode-darwin-arm64.tar.gz` + `SHA256SUMS`，校验 SHA256 后安装；
校验失败**什么都不安装**（与 `docs/RELEASE.md` §3 一致）。

---

## 2. 快速开始（5 分钟配一个国产 Provider）

`freecode setup --provider <id>` 一条命令完成：写 key（600 模式文件，不进配置）、
建 pool 条目、装 model。内置 provider 模板（`provider-templates.json`）：

| provider id | 厂商 | 端点 | 说明 |
| --- | --- | --- | --- |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat`（standard）/ `deepseek-reasoner`（expert） |
| `zhipu` | GLM（智谱） | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-4-flash`（free）/ `glm-4-plus` |
| `moonshot` | Kimi | `https://api.moonshot.cn/v1/chat/completions` | `kimi-k2` / `kimi-k2-turbo-preview` |
| `minimax` | MiniMax | `https://api.minimaxi.com/v1/chat/completions` | `abab-6.5s-chat` / `MiniMax-M1` |
| `ollama` | 本地 | `http://127.0.0.1:11434` | 无需 key；`qwen2.5-coder:14b` |

以 DeepSeek 为例（其他厂商同构，换 `--provider` 与 key 文件）：

```bash
# key 写入 ~/.freecode/secrets.env（mode 600），配置里只出现 {file:...} 引用
freecode setup --provider deepseek --api-key '<你的 DEEPSEEK_KEY>' --model deepseek-chat

# 验证端点可达（不发 LLM 请求）
freecode provider test deepseek

# 启动 TUI（零配置首跑路径：pool 有 model、key 可达即可）
cd 你的项目
freecode
```

TUI 里发一个任务（Head Agent 自动按 tier 路由）：

```
> 给 src/util.ts 加一个重试封装，带指数退避
```

任务完成后看路由决策：

```bash
freecode routes why        # 最近一次路由的完整解释
```

实跑输出（`934475c`，pool 已配 deepseek）：

```
$ freecode routes
Resources
  deepseek/deepseek-chat
    account default   tiers standard strong max   cost 1.00   health unseen

Current choice per tier
  local     deepseek/deepseek-flash score=0.629 (capability=0.70 quota=0.50 health=0.75 latency=0.50 reliability=0.50 cost=0.88)
  fast      deepseek/deepseek-flash score=0.629 ...
  standard  deepseek/deepseek-v4-pro score=0.626 ...
```

（`routes why` 在没有发生过路由决策时报 `No routing decision has been recorded yet.`，
属正常——第一次跑完任务后再看。）

### 配置手册要点（FREE-19 并入章节）

配置文件：`~/.config/freecode/freecode.jsonc`（`freecode config validate` 可校验）。

- **pool**：五个 capability tier（`local` / `fast` / `standard` / `strong` / `max`）
  各列 model，按优先级排序。router 决定任务需要哪个 tier，pool 决定用哪个 model。
- **provider**：每个「账号」是一个独立 provider id（如 `deepseek-main`、
  `deepseek-backup`），同厂商多账号即账号池，scheduler 按共享前缀归组。
- **凭据**：key 只写 `~/.freecode/secrets.env`（600 模式），配置里引用
  `{file:...}` 或 `{env:VAR}`，**永远不写进配置文件本身**（ADR-005；
  CI 的 secret-scan 会拦截明文 key）。
- 校验：`freecode config validate` → `✓ configuration is valid`。

调度器用户向说明（详见 `docs/architecture/03-scheduler.md`，此处只讲行为；
调度行为的精确实现以 v0.1.0 为准）：

- 六维打分：capability / quota / health / latency / reliability / cost，
  输出在 `freecode routes` 的 `score=` 行；
- 某厂商故障：health 下降 → 自动降级到其他同 tier model；全挂 → 任务标记
  SUSPENDED，TUI 提示而非静默失败；恢复后自动回到正常调度；
- 解释任意一次决策：`freecode routes why`。

---

## 3. 故障排查

### 3.1 `freecode doctor` 输出怎么读

结构：按组（Core / Router / Providers / Scheduler / Connectivity / Isolation /
Filesystem）逐行 `✓ ok` / `! warn` / `× fail`，结尾汇总。判定标准：

- 结尾是 **`FreeCode is usable.`** → 可正常跑任务（即使有 warn）；
- `×` 出现在 Core 组（workspace / data 不可写）→ 修权限再重试；
- `! Router / laya`（bridge not found）→ **可忽略**：纯规则路由仍然可用；
- `! Connectivity / <provider>` 401 → key 被拒绝，查 key 而不是网络
  （端点可达但 401 说明网络没问题）。

实跑输出摘录（干净环境，pool 已配、key 未配）：

```
! Router / laya: bridge not found; searched 3 locations
! Connectivity / deepseek: endpoint is reachable but refused the credential (401)
    no credential found; add one with `freecode account add`
FreeCode is usable.
```

### 3.2 常见失败

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `freecode: command not found` | 安装目录不在 PATH | 按安装输出加 `export PATH=...` 并 `exec zsh` |
| doctor 401 | key 无效 / 厂商侧过期 | 重新 `freecode setup --provider X --api-key ...` 或 `freecode account add` |
| `provider test` 超时 | 内网 / 代理 | 配代理后重试；端点选择见 §2 模板表 |
| 任务挂 SUSPENDED | 同 tier 全厂商不可用 | `freecode routes` 看各 provider health；补一个账号（`freecode account add`） |
| 隔离任务没合入 | 没跑 merge | `freecode tasks` 列出在途任务 → `freecode tasks merge <id>` |

### 3.3 stale binary（P0-5 防护）

验收 / 发布前必查（`scripts/version.sh`，`docs/RELEASE.md` §4）：

```bash
bash scripts/version.sh check
# 三项保证：package.json 版本 == 编译常量；binary 含该版本；RELEASE_TAG 时 tag 与 source 一致
```

---

## 4. 与 P0-8 验收的对应

P0-8（干净 Mac 人工验收）的 11 步中，本文档覆盖：安装（§1）→ 首跑
（§2）→ doctor / routes 判读（§3.1）。P0-8 走完整 11 步，本文档命令是其
可照做子集；两边证据互相印证。
