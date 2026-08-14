# 设计共识（已确定）

> 本文件是 pi-afk 的实现契约，记录已与用户逐轮确认的决策。
> 未决问题见 [open-questions.md](./open-questions.md)。

## 1. 定位与执行模式

- **A1 定位**：独立 pi 专属编排器（CLI），零依赖重写，不引入 `@ai-hero/sandcastle`。上游 sandcastle 仅作为"选择性借鉴清单"（E）。
- **A2 执行模式**：双模式 —— ① AFK 无人值守（容器隔离）；② 有人值守（宿主本地执行）。
- **A4 值守形态**：先做 ① 监控式值守（宿主跑流水线 + 实时透传）和 ② 即席命令（`afk run "<prompt>"`）；交互式值守 / 人在回路（RPC `steer`/`abort` 的 TUI、权限闸门）**后置**单独评估。

## 2. 架构

- **A3 共享核心 + 可插拔执行后端**：规划、阶段编排、prompt 渲染、git worktree、issue 状态机全部复用；只有"这一阶段在哪跑"可变。
  - **容器后端**：`docker run -d` + `docker exec`（AFK 模式）。
  - **宿主后端**：直接 `spawn pi`（有人值守 / 即席命令，≈ sandcastle `noSandbox()`）。
- **A5 接口契约**：纯 CLI、零 pi SDK。AFK 单阶段用 `pi --mode json`（JSONL 事件流），未来交互用 `pi --mode rpc`。**永不 import pi 包**。
- **A6 执行后端接口**：`Executor` = "跑一个阶段"的最小抽象，输入 `{ worktree, prompt, model, stage, branch }`，流式产出 pi 事件（session 头 / `text_delta` / `tool_execution_*` / `agent_end` …），返回 `{ exitCode, sessionId, stdout, stderr }`。JSONL 分帧、事件解析、实时渲染、信号识别、超时、退出码归一**全在共享层**；后端只是薄的 spawn 命令。
- **A7 容器生命周期**：每 issue 一个**常驻容器**（`docker run -d … sleep infinity`），planner → implementer → reviewer 三阶段顺序 `docker exec` 复用同一容器，依赖只 install 一次；成功/失败都用 `try/finally` `docker rm -f` 销毁。

## 3. 工作流程

- **三阶段**（默认锁定）：planner（只读、产出结构化 plan，zod 校验）→ implementer（实现 + 验证 + 提交）→ reviewer（审查 + 修复 + 提交）；每 issue 一个 worktree，三阶段串行、代码累积。
- **A8 分支模型**：一次性任务分支，**不采用长分支迭代**。
  - 成功：push 分支 → 删 worktree + 删本地分支。
  - 失败：注销 worktree + 删本地分支 + 归档到 `.pi/afk/failed/<branch>/`。
  - 重跑 = 从最新 `origin/main` 从头重做（不复用、不 ff）。
- **A9 可靠性**：借 sandcastle 双超时（idle 600s / completion 60s，环境变量可配）+ SIGINT 优雅打断（abort 当前阶段 → `finally` 清理 → 判 failed → 退出）。终态判定用 `--mode json` 的 `agent_end` / `agent_settled` 事件，**不用**文本里的 `<promise>COMPLETE</promise>`。
- **A10 重试策略**：planner zod 校验失败时用 `pi --session <id>` **续跑同一会话**、喂回校验错误（上限 2 次）；implementer/reviewer **不自动重试**，失败即 failed；瞬态 API 错误交给 pi 内置 auto_retry；超时算失败不重试。
- **A11 失败反馈**：失败时 `gh issue comment`（阶段 + 退出码 + stderr 尾段 + 日志/会话/归档路径 + "改回 `agent:todo` 重跑"提示）；成功时也 comment（分支名 + compare 链接）。issue 作为统一的人机回报界面。

## 4. 目录与配置

- **A12 布局**（复用 pi 的 `.pi` 规范，全部项目内、无全局配置）：

```
.pi/afk/
├── Dockerfile          # 项目级镜像定义（可选覆盖，后置）
├── prompts/            # planner/implementer/reviewer.md（可选覆盖，先做）
├── logs/               # afk 编排日志（host 侧事件，gitignore）
├── sessions/           # agent 会话记录：<issue>-<阶段>.jsonl（事件流，gitignore）
├── worktrees/          # 运行时 worktree（gitignore）
└── failed/             # 失败归档 worktree（gitignore）
```

- 读取规则：**存在则用，不存在则回退内置默认**（零配置 happy path 不变）。
- 先做 prompt 覆盖；Dockerfile 覆盖 + `afk init` 脚手架后置。
- **A13 会话记录**：**去掉 `pi-home` 挂载**。agent 会话以 `--mode json` 事件流落盘 `.pi/afk/sessions/`（完整、可 grep、含 session id）。放弃宿主 `pi -r` / `pi --export` 原生回看（记入已知取舍）。

## 5. 已采纳的 sandcastle 借鉴点

- 常驻容器（`createSandbox()` 形态）
- 双超时（idle / completion）
- 结构化输出续跑重试（`Output.object` + 会话续跑的机制，用于 planner）
- 失败/成功 issue 回写（issue-tracker 模板取向）
- 事件流 observability（对标 `onAgentStreamEvent`）
- 可选项目级配置覆盖（对标 `init` 脚手架的"用户拥有"模型，暂以可选覆盖实现）

## 6. 明确放弃（记入已知取舍）

- 长分支迭代 + 复用 worktree + 安全 ff（ADR 0003 那套）—— 与"一次性任务分支"语义相悖。
- 宿主 `pi -r` / `--export` 原生会话回看 —— 换取零挂载、零安全暴露。
- pi SDK 作为宿主依赖。
- 宿主全局 `~/.pi` 直接挂载进容器（安全回归）。

## 7. 宿主技术栈（默认锁定）

TypeScript + Node（ESM）；`zod` 为唯一运行时依赖；`spawn` + 手写 JSONL 分帧（不用 `readline`，规避 U+2028/2029 拆分问题）；构建 tsup、测试 vitest、包管理 pnpm。
