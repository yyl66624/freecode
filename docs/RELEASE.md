# FreeCode 发布流程（CI/CD、打包分发与回滚）

本文档描述 FreeCode 从「合入主干」到「用户可安装」的完整交付链，
以及发布出问题之后如何退回。它是 release agent 的操作手册，
也记录了每个环节对应的脚本，使发布流程可复现、可定位、可回滚。

---

## 1. 交付链总览

```
合入主干（freecode-main）
        │
        ▼
┌─────────────────────────────────────────────────────┐
│ CI（.github/workflows/freecode-ci.yml）             │
│  ① build        安装依赖 + 编译 freecode 二进制     │
│  ② typecheck    tsgo 全量类型检查                   │
│  ③ regression   基线测试集（config/provider/freecode）│
│  ④ vanilla      保留机制冒烟（vanilla-smoke.sh）    │
│  ⑤ secret-scan  样例/配置中无明文 key               │
└─────────────────────────────────────────────────────┘
        │  全绿
        ▼
打 tag（v<semver>）
        │
        ▼
┌─────────────────────────────────────────────────────┐
│ release（.github/workflows/release.yml，tag 驱动）  │
│  typecheck + freecode 单测 + 编译 + 冒烟           │
│  + 干净 prefix 安装 + 运行 + 校验 SHA256SUMS       │
│  + 上传 freecode-<platform>.tar.gz 到 GitHub       │
└─────────────────────────────────────────────────────┘
        │
        ▼
GitHub Release（freecode-<platform>.tar.gz + SHA256SUMS）
        │
        ▼
用户：scripts/install.sh --from-release
```

「从合入主干到可安装产物 < 30 分钟」的验收标准由上面这条链保证：
CI 全绿（约 15–20 分钟）+ tag 触发的 release 工作流（约 10 分钟）。
任一阶段失败都能定位到具体测试，见 §3。

---

## 2. CI 各阶段说明

| 阶段 | 脚本 | 失败时定位 |
| --- | --- | --- |
| build | `bun install --frozen-lockfile` + `bun run package` | 编译日志 + 平台 |
| typecheck | `bun run typecheck`（tsgo） | 类型错误行号 |
| regression | `bun test test/config test/provider test/freecode` | 失败用例名 + 输出；fail 数 ≤ 基线 5（这 5 个 fail 与上游基线一致，不是回归，见 `DEVELOPMENT.md`） |
| vanilla | `scripts/ci/vanilla-smoke.sh` | 三阶段：build / run / tests，任一失败打印具体哪一步 |
| secret-scan | `scripts/ci/secret-scan.sh` | 打印命中文件与可疑 token；已知假 key 走 allow-list |

**vanilla 冒烟是常驻门禁**（不是只在发布时跑）：最小侵入承诺的持续验证。
它验证的是「FreeCode 关掉之后，OpenCode 的保留机制仍可用」——
config 加载、provider 管道、git、permissions 这些 FreeCode 不允许碰的目录，
其测试必须仍然通过。这也是回滚路径：一个用户如果 FreeCode 层出问题，
可以退回同一二进制的 vanilla 行为（无 pool 配置时 doctor 会明确报告缺失，
而不是崩溃）。

---

## 3. 打包与分发

当前主分发 = 独立二进制 tarball（`freecode-<platform>.tar.gz` + `SHA256SUMS`）。
npm 包是分发路线的后续（`@freecode/cli` 封装同一 tarball 的安装逻辑），
当前阶段先保证二进制路径可用、可校验、可回滚。

- `scripts/release.sh` 产出物结构：`bin/freecode`、`bridge/`（Laya 可选加速层）、
  `UPSTREAM.md`、`LICENSE`。确定性归档（`COPYFILE_DISABLE=1`），
  跨机器校验一致。
- `SHA256SUMS` 随每个 release 上传；安装脚本默认校验，篡改的归档会明确失败
  且**什么都不安装**（反例测试在 DEVELOPMENT.md 已验证）。
- 安装：`scripts/install.sh`（本地构建）/ `install.sh --from-release`
  （下载 release tarball，校验 SHA 后安装）。

---

## 4. 版本管理

- 唯一事实源：`packages/opencode/package.json` 的 `version`。
  编译时常量在 `packages/opencode/src/freecode/freecode.ts` 的
  `export const version`，**必须与 package.json 保持同步**。
- `scripts/version.sh` 提供三个子命令：
  - `show`：打印 source / constant / binary 三个版本号
  - `bump <patch|minor|major>`：按 semver 规则打印提议的新版本号（只打印，不写文件）
  - `check`：三项保证——source 与 constant 一致；binary 包含 source 版本；
    （release 时设置 `RELEASE_TAG`）tag 与 source 版本一致
- Changelog 模板：`docs/CHANGELOG-TEMPLATE.md`。每个 release 复制一份、
  填充后改名为 `CHANGELOG-v<semver>.md`；GitHub release body 直接取自
  该文件内容（write-for-a-user，不是 write-for-a-committer）。

---

## 5. 回滚

回滚有三层保障，从轻量到重量：

1. **用户层**：上一个 release 的 tarball 永久保留在 GitHub releases 页面。
   用户下载上一个版本、校验 SHA、重新运行 `install.sh --from-release` 即可。
   FreeCode 的 `~/.config/freecode` 与 `~/.local/share/freecode`
   与二进制独立，回滚二进制不影响配置与数据。
2. **行为层（vanilla）**：同一二进制在无 FreeCode pool 配置时以 vanilla
   行为运行，doctor 明确报告缺失而非崩溃。这是「保留机制」的持续验证
   （CI 常驻）。
3. **发布层**：`release.yml` 的 tag 驱动发布天然按 tag 保留每个版本产物。
   回滚到某个历史版本 = 重新发布该 tag 的产物 + 更新「latest release」链接。

回滚操作（release agent 视角）：

```sh
# 1. 找到上一个 release 的 tag
git tag -l 'v*' --sort=-version:refname | head -3

# 2. 重新构建并上传该 tag 的产物（或从 GitHub release 下载历史产物）
git checkout <prev-tag>
bun run package && ./scripts/release.sh

# 3. 上传到 GitHub（保留历史产物，不删除）
gh release create <prev-tag> dist/release/* --title "re-release <prev-tag>"

# 4. 更新安装脚本默认指向的 release（若需要）
```

---

## 6. 安全：凭据样例扫描

- 安装脚本与样例配置中**不允许出现明文 key**（呼应 ADR-005：
  secret 走 `~/.freecode/secrets.env` mode 600，配置里写 `{env:...}`
  或 `{file:...}` 引用，不写 key 本身）。
- CI 的 `secret-scan` 阶段用 `scripts/ci/secret-scan.sh` 扫描
  `.freecode/`、`docs/`、README、安装/发布脚本等样例与模板表面，
  命中「key 形」字符串且不在 allow-list（已知假 key，如 `broken`
  provider 的测试 key `sk-invalid-key-for-failover-testing`）即失败。
- 离线、无外部依赖（grep + 有界文件列表），保证任何 CI 机器可复现。

---

## 7. 与 P0 冻结期的关系

本文件描述的是**发布基础设施**，与 P0 冻结期内隔离修复（P0-4）、
stale-binary 防护（P0-5，对应 `scripts/version.sh check` 的 binary 版本
一致性检查 + `vanilla-smoke.sh build` 阶段重建二进制）、
干净 Mac 全链路验收（P0-8）、打 RC（P0-9）互为支撑：

- P0-5 的「binary build SHA 与源码 HEAD 一致」由 `version.sh check`
  + `vanilla-smoke.sh build`（每次冒烟前重建）共同保证。
- P0-9 打 RC 时：`git tag v0.x.y` → 触发 `release.yml` → 全绿后
  产物上传 → 按 §5 保留上一版可下载。
