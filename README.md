# pi-afk

基于 [sandcastle](https://github.com/mattpocock/sandcastle) + [pi](https://github.com/earendil-works/pi-coding-agent) 的 **AFK（无人值守）循环编排器**。

你在 GitHub 上创建带 `afk` 标签的 issue，pi-afk 自动完成剩下的：

```
创建 issue → 沙箱内 agent 实现 → 自动提交 → 预同步合并 → 推送分支 → 开 PR → （可选）自动合并 → issue 自动关闭
```

整个循环无人值守（AFK = away from keyboard），你可以放心离开。**沙箱保守派设计**：凭据、push、PR 全部由宿主机完成，沙箱内的 agent 只接触隔离的工作副本。

---

## 目录

- [工作原理](#工作原理)
- [前置条件](#前置条件)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [提示词模板](#提示词模板)
- [与 prd-to-issues skill 集成](#与-prd-to-issues-skill-集成)
- [依赖处理](#依赖处理)
- [日志与事件](#日志与事件)
- [安全模型](#安全模型)
- [故障排查](#故障排查)
- [开发](#开发)

---

## 工作原理

`afk <N>` 会串行处理 N 个开放 issue（parallel-ready 结构，未来可并行）。每个 issue 的完整流程：

```
宿主（你的机器）                          沙箱（Docker 容器，零凭据）
─────────────────────                    ─────────────────────────────
1. 拉取开放 issue（按配置 labels 过滤；未配置 = 不过滤全部拉取）
2. 按编号升序取第一个
3. 宿主刷新 origin/main
   （git fetch origin main；失败时降级本地 HEAD，不阻断）
4. 创建独立分支 agent/issue-N
   （git worktree，从最新 origin/main 创建，不影响你的工作区）
5. 组装 prompt（模板 + issue 内容）
                                         6. 启动容器（镜像 pi-afk:latest）
                                         7. 按 lockfile 类型处理依赖
                                            · pnpm：共享宿主 store 秒级重建
                                            · npm/yarn：复制 node_modules + 增量安装
                                         8. 运行 pi agent：
                                            探索 → 计划 → TDD 实现
                                            → 验证（typecheck + test）
                                            → 提交（只提交，不 push）
                                         9. 输出 <promise>COMPLETE</promise>
                                            和结构化 <outcome>{status, summary}
10. 解析 outcome：
   · done + 有提交 → 预同步 + push 分支 + 创建 PR
     （PR body 含 "Closes #N"，合并后
       GitHub 自动关闭 issue）
     · 预同步（T11）：push 前宿主把最新
       origin/main 合并进分支（分支 worktree
       内执行 git merge，宿主操作）：
        合并干净 → 继续发布
        合并冲突 → 中止合并、分支照常推送 +
        建 PR + PR 留言冲突文件清单与下一步
        建议（不自动合并），该 issue 本轮跳过
     · 配置了 verifyCommand 时 → 预同步后、
       push 前在分支临时 worktree 执行验证
       （校验合并后状态）：
        零退出 → 正常发布
        非零退出 → 留言说明验证失败、
        不 push 不发版、该 issue 本轮停止
   · done + 无提交 → 留言警告，不建 PR
   · blocked/skipped → issue 留言说明原因，
     本轮跳过
   · autoMerge 开启时 → 自动 squash 合并 PR
     （合并失败等 30 秒重试一次，仍失败报错保留 gh 输出）
10. 写事件日志（~/.afk/logs/afk.jsonl）
11. 进入下一个 issue
```

### 设计要点（协议）

- **agent 只提交，不 push、不关 issue、不改 label** —— 所有写远端操作由宿主完成，凭据不进沙箱
- **完成信号**：agent 输出 `<promise>COMPLETE</promise>` 结束一轮；结构化输出 `<outcome>` 是 zod 校验的 JSON（`{ status: 'done'|'blocked'|'skipped', summary }`），校验失败自动重试
- **进度锚点**：prompt 中注入最近 10 条 `Ralph:` 提交，让 agent 知道之前的进度
- **依赖顺序**：issue 按编号升序处理 —— 配合按依赖顺序创建 issue 的规范，先被依赖的先实现
- **合并重试**：autoMerge 合并失败先等 30 秒重试一次（PR 刚创建时 GitHub 尚未算好可合并性），重试仍失败则报错并保留 gh 原始输出
- **预同步合并（T11）**：agent 完成后、push 前，宿主把最新 `origin/main` 合并进分支（在分支临时 worktree 内执行 `git merge`，宿主操作、不涉沙箱凭据；sandcastle 干净 run 后会删除 worktree，故与验证门同一模式重建临时 worktree，不碰宿主主工作区）。合并干净 → 正常发布；合并冲突 → 中止合并还原分支、分支照常推送 + 创建 PR + **PR 留言冲突文件清单与下一步建议**（不留无声 dirty PR，hacxy.cn #23 事故教训）、不自动合并、该 issue 本轮跳过（不阻塞循环）
- **验证门（可选）**：配置 `verifyCommand`（如 `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test:run`）后，发布流水线在预同步合并之后、push 之前于分支临时 worktree 执行该命令（干净检出，随用随删，不依赖沙箱 worktree 生命周期），校验的是将要推送的合并后状态，非零退出即停摆——留言说明验证失败、不发版、该 issue 本轮停止；默认不配置 = 信任 agent 声明（行为与现状一致）

---

## 前置条件

| 依赖                          | 用途                    | 安装                                                   |
| ----------------------------- | ----------------------- | ------------------------------------------------------ |
| Node.js ≥ 20                  | 运行 pi-afk / pi        | [nodejs.org](https://nodejs.org)                       |
| Docker（macOS 推荐 OrbStack） | 沙箱容器                | [orbstack.dev](https://orbstack.dev)                   |
| gh CLI + 登录                 | GitHub issue / PR 操作  | `brew install gh && gh auth login`                     |
| DEEPSEEK_API_KEY              | 沙箱内 agent 的模型凭据 | [platform.deepseek.com](https://platform.deepseek.com) |

> 沙箱内 agent 直接调用 DeepSeek API（`DEEPSEEK_API_KEY` 注入容器环境变量，容器联网即可，无需额外配置）。

---

## 安装

> ⚠️ 尚未发布 npm（见[路线图](#开发)），当前从源码安装：

```bash
git clone https://github.com/hacxy/pi-afk.git
cd pi-afk && pnpm install && pnpm build
pnpm link --global        # 提供 afk 命令（开发模式）
```

---

## 快速开始

```bash
# 1. 设置模型凭据（写入 shell 配置 ~/.zshrc 持久化）
export DEEPSEEK_API_KEY=sk-xxxxxxxx

# 2. 可选：提前初始化（构建沙箱镜像 ~1-2 分钟、生成全局配置）
afk init

# 3. 在任何项目里直接跑（首次自动完成所有初始化）
cd 你的项目
afk 10        # 处理 10 个开放 issue（没有则立即结束）
```

**首次运行自动做的事**（无需手动 `afk init`）：

1. 生成全局配置 `~/.afk/config.json`（跨所有项目共享）
2. 检查/构建沙箱镜像 `pi-afk:latest`（全局一次，所有项目复用）
3. 向项目 `.gitignore` 追加 sandcastle 运行时产物忽略规则（幂等，仅 `.sandcastle/.env` / `logs/` / `worktrees/` 三条，`prompt.md` 可提交）
4. 幂等复制默认模板到项目 `.sandcastle/prompt.md`（已存在则跳过）
5. 检查 DEEPSEEK_API_KEY，缺失则明确报错

**在项目里创建第一个任务**：

```bash
gh issue create --title "实现 xxx" --body "请实现 xxx，并添加测试" --label afk
afk 1
```

每次 `afk <N>` 启动时会打印一行当前生效的模板路径（`→ 使用模板: <绝对路径>`），随时可见模板来自哪一层。

### 诊断：`afk doctor`

对配置/模板“黑盒”问题的排查入口——一次性显示合并后的生效配置（5 字段）、实际使用的模板绝对路径、沙箱镜像是否存在、gh 是否登录：

```bash
cd 你的项目 && afk doctor
```

```
=== afk doctor ===

配置（生效合并值）:
  image:     pi-afk:latest
  model:     deepseek/deepseek-v4-flash
  labels:    （无——不过滤）
  autoMerge: off
  verify:    （无——跳过验证）

模板: /path/to/.sandcastle/prompt.md （项目自定义）

检查项:
  ✓ 沙箱镜像: 存在
  ✓ gh 登录: 已登录
```

`afk doctor` 是**纯只读诊断**：不生成配置、不构建镜像、不复制模板，无任何副作用；无配置文件/无自定义模板的干净环境也能正常输出（显示默认值）。

---

## 配置

### 环境变量

| 变量               | 必填 | 说明                                      |
| ------------------ | ---- | ----------------------------------------- |
| `DEEPSEEK_API_KEY` | ✅   | DeepSeek API key（注入沙箱供 agent 使用） |

### 全局配置 `~/.afk/config.json`

全局唯一配置源（跨所有项目共享），只保留 5 个用户真正会改的字段：

```jsonc
{
  "image": "pi-afk:latest", // 沙箱镜像名
  "model": "deepseek/deepseek-v4-flash", // 沙箱 agent 模型（pi 的 provider/model 格式）
  "labels": [], // 拉取 issue 的标签（数组，任一命中即拉取；空数组 = 不过滤全部拉取）
  "autoMerge": false, // 可选：done 后自动 squash 合并 PR
  "verifyCommand": "", // 可选：发布（T8）push 前在分支临时 worktree 执行的验证命令（如 "pnpm install --frozen-lockfile && pnpm typecheck && pnpm test:run"）；空/缺失 = 跳过验证，信任 agent 声明
}
```

> `verifyCommand` 为验证门：配置后每次发布前在分支临时 worktree（干净检出，随用随删）执行该命令，非零退出即停摆——留言说明验证失败、不发版、该 issue 本轮停止；零退出则正常继续发布。命令需自行准备依赖（如 `pnpm install --frozen-lockfile`，与沙箱共享宿主 pnpm store，秒级完成）。

> 旧配置的 `label`（字符串或数组）字段会被自动迁移为 `labels` 数组，无需手动改。

> 其余行为项硬编码为代码常量：日志目录固定 `~/.afk/logs`，完成信号固定 `<promise>COMPLETE</promise>`。旧配置中的其他字段（如 `logDir`/`completionSignal`/`promptFile`）会被忽略且不报错。

---

## 提示词模板

采用 **sandcastle 官方标准**：模板文件固定为项目 `.sandcastle/prompt.md`。自定义提示词模板只有一条规则：**把模板文件放到项目 `.sandcastle/prompt.md`（可提交 git，团队共享）**；没有则用包内内置默认模板。

```
优先级 1   项目 .sandcastle/prompt.md   ← 用户自定义（可提交 git，团队共享）
优先级 2   包内 prompts/prompt.md       ← 默认（sandcastle 官方 simple-loop 命名）
```

### 占位符

| 占位符               | 内容                              |
| -------------------- | --------------------------------- |
| `{{ISSUE_NUMBER}}`   | issue 编号                        |
| `{{ISSUE_TITLE}}`    | issue 标题                        |
| `{{ISSUE_BODY}}`     | issue 正文                        |
| `{{ISSUE_COMMENTS}}` | issue 评论（含用户追问）          |
| `{{RECENT_COMMITS}}` | 最近 10 条 Ralph 提交（进度锚点） |
| `{{BRANCH}}`         | 当前分支名                        |

占位符注入是宿主侧行为（pi-afk 相对 sandcastle 官方“沙箱内执行 gh 命令”的差异化价值），模板可直接使用 `{{KEY}}`。

### 初始化与 git 身份

- `afk init`（或首次运行）会幂等地把默认模板复制到项目 `.sandcastle/prompt.md` 作为可编辑起点；已存在则跳过，不覆盖你的修改
- 沙箱内 agent 的 git commit 自动使用宿主的 `user.name`/`user.email`（sandcastle 从宿主 git config 读取并注入沙箱），模板无需（也不应）硬编码身份

---

## 与 prd-to-issues skill 集成

配合 [prd-to-issues](../.pi/agent/skills/prd-to-issues/SKILL.md) skill，PRD → 垂直切片 → AFK 自动实现，形成完整闭环：

```
PRD issue → skill 拆成垂直切片（按依赖顺序创建）
              ├─ HITL 切片 → --label hitl（架构决策/设计评审，人工处理）
              └─ AFK 切片  → --label afk（pi-afk 自动实现 + 合并）
```

- **AFK 切片**：`gh issue create ... --label afk`，pi-afk 自动实现、开 PR、可自动合并（`afk` 需在配置 `labels` 中）
- **HITL 切片**：`--label hitl`，pi-afk 不拉取；即使误标 `afk`，正文中的 `## 类型（Type）\n\nHITL` 标记也会被识别并跳过，`no-more-tasks` 事件会报告待人工处理的数量
- **依赖顺序**：skill 按依赖顺序创建 issue，pi-afk 按编号升序处理，天然对齐

开启自动合并以完整实现"AFK 切片无人参与实现并合并"：

```jsonc
// ~/.afk/config.json
{ "autoMerge": true }
```

合并采用 `--squash --delete-branch`，PR body 中的 `Closes #N` 会让 GitHub 在合并时自动关闭 issue。

---

## 依赖处理

沙箱默认没有宿主项目的依赖，pi-afk 按 lockfile 类型自适应安装：

| lockfile            | 策略                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`    | **不复制宿主 node_modules**（macOS 产物是跨平台问题根源）；共享宿主 pnpm store（实测 149M 项目 1.9s 重建 Linux 原生依赖） |
| `package-lock.json` | 复制宿主 node_modules + `npm install` 增量修复                                                                            |
| `yarn.lock`         | 复制宿主 node_modules + `yarn install` 增量修复                                                                           |
| 无 lockfile         | 复制宿主 node_modules，agent 自行处理                                                                                     |

> pnpm store 是**可写**共享（pnpm 需写 sqlite 索引，实测只读会失败）。最坏情况是缓存损坏重新下载，非灾难。

### 沙箱镜像与宿主对齐

- **pnpm 版本**：构建镜像时自动注入宿主 `pnpm --version`（`ARG PNPM_VERSION` build-arg），沙箱内 pnpm 永远与宿主一致，不硬编码版本。
- **UID/GID**：构建时注入宿主 `id -u` / `id -g`（sandcastle 预检要求）。
- 宿主未安装 pnpm 时构建会明确报错（宁可失败也不静默漂移）。

---

## 日志与事件

- **每次 issue 的沙箱日志**：`~/.afk/logs/issue-<N>.log`（pi 原始输出，`tail -f` 可实时观察）
- **事件流**：`~/.afk/logs/afk.jsonl`（结构化 JSON lines，为 Web UI 预留）

日志条目类型：`run-start` / `run-end` / `iteration-start` / `issue-picked` / `issue-result` / `presync-conflict` / `presync-fetch-failed` / `verify-failed` / `no-more-tasks` / `fetch-origin-main-failed` / `error`。

---

## 安全模型

**保守派沙箱**（对比激进派沙箱的取舍）：

| 能力                     | 沙箱内 agent        | 宿主           |
| ------------------------ | ------------------- | -------------- |
| 凭据（DEEPSEEK_API_KEY） | ✅（模型必需）      | ✅             |
| Git 提交                 | ✅（本地提交）      | —              |
| push / PR / 关 issue     | ❌                  | ✅（统一执行） |
| gh CLI                   | ❌（镜像不含）      | ✅             |
| 宿主文件系统             | ❌（隔离 worktree） | ✅             |
| 模型调用                 | ✅（沙箱网络）      | —              |

选择保守派的理由：凭据永不进沙箱、远端写操作可审计、沙箱镜像可安全共享。

---

## 故障排查

| 现象                                                    | 原因                          | 解决                                                                                           |
| ------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `Authentication Fails ... api key invalid`              | DEEPSEEK_API_KEY 未设置或无效 | `echo $DEEPSEEK_API_KEY` 确认；从平台重新生成                                                  |
| `完成：没有可处理的开放 issue`                          | 没有符合条件的开放 issue      | `gh issue list` 查看；配置了 labels 时检查标签名与配置一致，未配置时检查是否确实没有开放 issue |
| `Structured output tag <outcome> contains invalid JSON` | agent 输出不符合协议          | 查看 `~/.afk/logs/issue-N.log` 尾部；通常是模型/网络问题，重试                                 |
| 镜像构建失败                                            | Docker/OrbStack 未运行        | 启动 OrbStack 后重试 `afk init`                                                                |
| git push rejected (non-fast-forward)                    | issue 已处理过（旧分支残留）  | 合并/关闭旧 PR 和 issue；删除本地 `agent/issue-N` 分支                                         |
| 沙箱内测试失败（平台二进制）                            | 宿主 node_modules 跨平台      | pnpm 项目已自动解决；npm/yarn 项目靠增量 install 修复                                          |

---

## 开发

```bash
pnpm install
pnpm build       # tsup 构建（产出 dist/）
pnpm test:run    # 单元测试（vitest）
pnpm lint        # eslint
pnpm exec tsc --noEmit   # 类型检查
```

**端到端验证流程**（真实跑通）：在测试仓库创建 issue（配置了 labels 则带对应标签）→ `node dist/cli.js 1` → 观察沙箱 agent 工作 → 验证 PR 创建。

### 路线图（未实现）

- [ ] npm 发布（bin: afk）
- [ ] 并行模式（事件模型已预留，processIssue 是纯异步函数）
- [ ] Web UI（事件流数据已就绪）
- [ ] 多模板集（implement/review/plan 等官方工作流）
