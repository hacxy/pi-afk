# 剩余待讨论（未决）

> 新窗口接续讨论时读本文件。已确定部分见 [decisions.md](./decisions.md)。
> 编号沿用会话中的维度（D = 工作流程，E = 未来方向/借鉴，T = 技术验证）。

## 一、待决策（讨论主线，按优先级）

### D1. 交付形态（最大缺口）

成功 push 分支之后，要不要自动 **merge / 关 issue / 开 PR**？还是维持"push + comment、issue 保持 open"？

- 现状：只 push + label `agent:done` + comment，不 merge 不关。
- 选项：自动 merge 并关 issue；开 PR 等人工 merge；维持现状。
- 影响：整个工具的"省心程度"，也是与 sandcastle 差最多的地方。

### D2. 依赖 install 谁负责 —— ✅ 已定（issue #39，见 [decisions.md §9](./decisions.md#9-a7d2-落地容器常驻后端--依赖编排层安装issue-39已实现)）

编排层在容器就绪时用 hook 主动装（onSandboxReady 模式）：lockfile 检测安装命令，`AFK_INSTALL_CMD` 可覆盖；agent 不自装，prompt 已移除 install 指令。

### D3. 值守模式的 CLI 形态

- 即席命令 `afk run "<prompt>"`：具体参数？是否走三阶段？用 host 后端？
- 监控式值守：`afk --mode host`？实时透传的渲染方式（文本增量怎么画到终端）？

### D4. 多 sandbox provider 范围

A3 的"可插拔后端"是否**只做 docker + host**，还是预留 podman / vercel / no-sandbox 的接口位置？（建议：接口预留、实现只做 docker+host）

### D5. 多 agent 引擎

A1 已定 pi 专属。确认"**永不支持** claudeCode/codex/…"（彻底锁死）还是"接口上不预留、将来再说"？

## 二、待确认（现状默认，走个过场即可）

### D6. 并发语义

信号量 `MAX_PARALLEL`（默认 2）保持？多 issue 并发时容器命名/资源隔离细节。

### D7. 验证门

implementer 提交前 `typecheck` / `test` / `lint` 三件套保持？是否加 `build` / e2e？

### D8. label 状态机

`agent:todo → agent:done / agent:failed` 保持？`done` 后是否自动关 issue（与 D1 相关）。

## 三、已后置（明确标记，等需要再做）

### E1. 交互式值守（人在回路）

RPC `steer`/`abort` 驱动的 TUI 会话 + 工具审批/权限闸门。（A4 已后置）

### E2. `afk init` 脚手架

把默认 Dockerfile / prompts 复制进 `.pi/afk/` 供用户改（对标 sandcastle `init`）。

### E3. Dockerfile 项目级覆盖 + build-image

检测到 `.pi/afk/Dockerfile` 就构建/复用项目镜像（对标 sandcastle `build-image`）。

### E4. 跨容器续跑（D1 欠账）

失败保留分支 + `pi --resume` 续跑，解决"失败重跑全重来"。等咬疼了再做。

### E5. prompt 增强

`` !`command` `` 动态上下文、内置 `{{SOURCE_BRANCH}}`/`{{TARGET_BRANCH}}`。

### E6. 模板体系

blank / simple-loop / sequential-reviewer / parallel-planner 等（pi-afk 固定三阶段，大概率不需要）。

### E7. 结构化输出通用化

把 planner 的续跑重试通用化成 `Output.object({ maxRetries })` 一等公民。

## 四、需验证的技术隐患（实现前先验，不属"讨论"）

### T1. 容器内 git commit 是否真的能工作（✅ 已验证，见 [decisions.md §8](./decisions.md#8-t1-技术验证容器内-git-提交issue-37已实测)）

worktree 的 `.git` 是文件、内容指向**宿主**的 `.git/worktrees/<branch>`，在容器内该路径不存在。若 `git commit` 在容器里失效，则"agent 在容器内提交"这一核心前提要重新设计（如改为宿主侧 commit）。**实现切片 1 前必须先验证。**

- **结论**：朴素挂载下容器内 git 全部失效；采用接缝方案 **A'**（宿主 `.git` 同路径可写挂载 + hooks/config 子挂载只读）后容器内 commit 可行，已实测。

### T2. 并发下容器/会话/资源隔离

多 issue 并发时：容器命名（按 branch）、`--mode json` 会话落盘路径、`.pi/afk/sessions/` 文件命名，避免互相覆盖。

---

## 讨论顺序建议

1. 先解决 **D1 交付形态**（最大，且影响 D8）。
2. 再 D2 / D3 / D4 / D5（技术栈收尾）。
3. D6 / D7 / D8 走个过场确认。
4. E 系列按需排期，不进近期切片。
