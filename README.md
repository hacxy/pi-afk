# pi-afk · AFK 无人值守循环编排器

> 基于 [pi](https://pi.dev) 的多 Agent 无人值守开发循环 —— 把一份任务清单交给编排器，它在一个个隔离的 worktree 里反复调度"实现 → 审查 → 合并"三角色 Agent，直到 **agent:todo** 清空。

AFK = **A**way **F**rom **K**eyboard。理念与 [Ralph Wiggum 模式](https://github.com/snarktank/ralph)（spec-driven autonomous development loop）一致：长时运行的 Agent 循环，每轮迭代使用全新上下文，规避单次会话的上下文膨胀、状态丢失与无限循环问题。

## 解决的问题

单一 Agent 会话跑长任务的三个通病：

| 通病 | afk 的解法 |
| --- | --- |
| 上下文膨胀、AI 跑偏 | 每个任务一个全新上下文的 Agent 会话 |
| 并行开发互相污染 | 每个 issue 一个隔离 git worktree（`maxParallel` 可配） |
| 质量没保障、改完没人审 | 强制 implementer → reviewer → merger 流水线，审查不通过不进主分支 |

## 架构

```
                        ┌─────────────────────────────┐
   gh issue (agent:todo)│         afk 编排器           │
   ────────────────────▶│  config 校验 → 身份校验       │
                        │  └─ 挑选待办 issue（并发 ≤N） │
                        └──────────┬──────────────────┘
                                   │
              ┌────────────┬───────▼───────┬────────────┐
              ▼            ▼               ▼            ▼
        git worktree  install deps   git worktree  install deps
        ┌──────────────────┐          ┌──────────────────┐
        │ implementer Agent│          │ implementer Agent│
        │  写代码+验证+提交 │          │  写代码+验证+提交 │
        └────────┬─────────┘          └────────┬─────────┘
                 ▼                            ▼
        ┌──────────────────┐          ┌──────────────────┐
        │ reviewer Agent   │          │ reviewer Agent   │
        │  diff 审查       │          │  diff 审查       │
        └────────┬─────────┘          └────────┬─────────┘
                 ▼                            ▼
        ┌──────────────────┐          ┌──────────────────┐
        │ merger Agent     │          │ merger Agent     │
        │ 合入 base 分支    │          │ 合入 base 分支    │
        └───────┬──────────┘          └───────┬──────────┘
                ▼                            ▼
         label: agent:done            label: agent:failed
                                  （失败原因写回日志，下轮可重试）
```

每轮循环：拉取全部 `agent:todo` issue → 并发完整流程（依赖安装 → 实现 → 审查 → 合并）→ 汇总报告 → 重复直到清空或达到迭代上限。

## 快速开始

```bash
# 1. 安装（向项目写入 .pi/afk/ 配置）
npx @hacxy/pi-afk init

# 2. 用「实现一个 issue」的粒度写待办任务，并打上标签
gh issue create --title "实现用户注册接口" --label "agent:todo"

# 3. 无人值守跑循环（参数 = 最大迭代轮数，默认 1）
npx @hacxy/pi-afk 20
```

遵守铁律：**不手动改动 worktree**，一切改动由 Agent 完成。

## 配置（.pi/afk/config.json）

```jsonc
{
  "model": "deepseek/deepseek-v4-flash", // Agent 使用的模型
  "thinking": "medium",                  // 推理强度
  "maxParallel": 2,                      // 并行 worktree 数
  "todoLabel": "agent:todo",             // 状态机标签
  "doneLabel": "agent:done",
  "failedLabel": "agent:failed",
  "branchPrefix": "afk",                 // worktree 分支前缀
  "baseBranch": "main",
  "worktreesDir": ".pi/afk/worktrees",
  "idleTimeoutSec": 600,                 // 无进度熔断
  "completionTimeoutSec": 60
}
```

## 角色分工

| 角色 | Prompt | 职责 |
| --- | --- | --- |
| implementer | `prompts/implementer.md` | 探索 → 最小改动计划 → 写代码 → 验证（typecheck/lint/test）→ 提交 |
| reviewer | `prompts/reviewer.md` | 审查 `base...HEAD` 的 diff，不达标打回 |
| merger | `prompts/merger.md` | 合入 base、解决冲突 |
| fixer | `prompts/fixer.md` | 失败重试链路 |

## 工程要点

- **依赖安装不交给 Agent**：按 lockfile（pnpm/npm/yarn/bun）在宿主侧安装，避免 Agent 擅自改依赖
- **启动即校验**：config 缺失 / git 提交身份缺失 → 干净报错，绝不带病进循环
- **失败可观测**：issue 级日志、session 记录、失败原因落盘，重试不重做
- **测试即门禁**：每个 role prompt 都要求先读测试再动手，改动必须通过验证

## 技术栈

TypeScript · cac（CLI）· execa（进程编排）· p-map（并发控制）· zod（配置校验）· vitest · tsup

## License

MIT
