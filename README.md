# pi-afk

基于 pi 的**无人值守循环编排器**——最小版 sandcastle：宿主 ts 程序负责编排（拉 issue、起容器、并发、失败处理），agent 推理交给容器内的 `pi -p`。

> 与 sandcastle 的区别：不依赖 `@ai-hero/sandcastle` 库，只重写它的循环骨架，agent 引擎固定是 pi。

## 架构

```
afk（宿主 ts 程序，零 pi SDK 依赖）
  → gh 拉 open issues（label: agent:todo，且不含 done/failed）
  → 每个 issue：一个 git worktree + 一个常驻容器，三阶段 docker exec 复用
       planner（pi -p → 结构化 JSON plan → zod 校验）
     → implementer（pi -p → 写代码 + 验证 + 容器内 commit）
     → reviewer（pi -p → 审查 + 直接修复 + commit）
  → 宿主 push 分支 origin/afk/issue-N-slug
  → label 状态机：agent:todo → agent:done（成功）/ agent:failed（失败）
```

- **容器隔离**：每 issue 一个常驻容器（`docker run -d` + `docker exec`），三阶段复用、依赖只装一次；成功/失败均 `try/finally` 销毁（无孤儿容器）
- **依赖安装**：编排层在容器就绪时按 lockfile 主动装（pnpm/npm/yarn/bun），agent 不自装（`AFK_INSTALL_CMD` 可覆盖）
- **并发**：信号量 `MAX_PARALLEL`（默认 2）
- **可观测性**：容器内 pi session 以 `--mode json` 事件流落盘 `.afk/sessions/<branch>-<stage>.jsonl` + 宿主日志 `.afk/logs/afk-*.log`

## 快速开始

```bash
# 1. 构建工作容器镜像
docker build -t pi-workspace --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) .

# 2. 在目标项目目录运行（afk 在 cwd 解析 GitHub repo）
cd /path/to/target-repo
afk

# 3. 即席命令：宿主本地单会话 pi（实时透传 + 落盘 .afk/sessions/）
afk run "修复登录页 bug"
```

## label 状态机

| label          | 谁打   | 含义                                           |
| -------------- | ------ | ---------------------------------------------- |
| `agent:todo`   | 你手动 | 交给 agent 处理（入口）                        |
| `agent:done`   | afk    | 分支已 push、实现完成（终态，issue 保持 open） |
| `agent:failed` | afk    | 失败（终态，改回 todo 才重跑）                 |

## 配置（环境变量）

| 变量                                                     | 默认                                         | 说明                                        |
| -------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| `AFK_IMAGE`                                              | `pi-workspace`                               | 工作容器镜像                                |
| `AFK_MODEL`                                              | `deepseek/deepseek-v4-flash`                 | implementer 模型                            |
| `AFK_PLANNER_MODEL`                                      | 同 MODEL                                     | planner 模型                                |
| `AFK_REVIEWER_MODEL`                                     | 同 MODEL                                     | reviewer 模型                               |
| `AFK_THINKING`                                           | `medium`                                     | 思考等级                                    |
| `AFK_MAX_PARALLEL`                                       | `2`                                          | 并发信号量上限                              |
| `AFK_TODO_LABEL` / `AFK_DONE_LABEL` / `AFK_FAILED_LABEL` | `agent:todo` / `agent:done` / `agent:failed` | label 状态机                                |
| `AFK_BRANCH_PREFIX`                                      | `afk`                                        | 分支前缀                                    |
| `AFK_SESSIONS_DIR`                                       | `.afk/sessions`                              | 会话 JSONL 落盘目录（`--mode json` 事件流） |
| `AFK_INSTALL_CMD`                                        | 按 lockfile 检测                             | 依赖安装命令覆盖（容器就绪时编排层执行）    |
| `AFK_IDLE_TIMEOUT_SEC`                                   | `600`                                        | idle 超时（无事件活动上限，秒）             |
| `AFK_COMPLETION_TIMEOUT_SEC`                             | `60`                                         | completion 宽限（终态后等进程退出，秒）     |

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm build          # 产出 dist/cli.js（bin: afk）
```

## 范围（当前切片）

- ✅ 无人值守循环：常驻容器三阶段（planner → implementer → reviewer → push 分支）+ 报告；依赖编排层安装一次
- ✅ `afk run "<prompt>"` 即席命令：宿主本地单会话 pi，实时透传 + 会话 JSONL 落盘 + 双超时
- ⏸️ planner 续跑重试（`pi --session` 喂回校验错误）、超时判失败、SIGINT 优雅打断；回报 + 失败归档 + 关 issue；交互模式（工具路由）、skills —— 后续轮次
