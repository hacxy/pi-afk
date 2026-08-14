/**
 * 配置：全部来自环境变量，带默认值。
 * afk 在目标项目根目录运行（process.cwd() = 目标仓库），所有相对路径基于 cwd。
 */
export const config = {
  /** implementer 模型 */
  model: process.env.AFK_MODEL ?? 'deepseek/deepseek-v4-flash',
  /** 思考等级 */
  thinking: process.env.AFK_THINKING ?? 'medium',
  /** 并发信号量上限 */
  maxParallel: Number(process.env.AFK_MAX_PARALLEL ?? 2),
  /** issue label 状态机 */
  todoLabel: process.env.AFK_TODO_LABEL ?? 'agent:todo',
  doneLabel: process.env.AFK_DONE_LABEL ?? 'agent:done',
  failedLabel: process.env.AFK_FAILED_LABEL ?? 'agent:failed',
  /** 分支前缀 */
  branchPrefix: process.env.AFK_BRANCH_PREFIX ?? 'afk',
  /** 基线分支（worktree 起点 + compare 链接 base + PR base） */
  baseBranch: process.env.AFK_BASE_BRANCH ?? 'main',
  /** 运行时产物目录（相对 cwd，gitignore） */
  worktreesDir: process.env.AFK_WORKTREES_DIR ?? '.pi/afk/worktrees',
  /** 失败现场归档目录（相对 cwd，gitignore） */
  failedDir: process.env.AFK_FAILED_DIR ?? '.pi/afk/failed',
  logsDir: process.env.AFK_LOGS_DIR ?? '.pi/afk/logs',
  /** 会话记录目录：--mode json 事件流落盘（gitignore） */
  sessionsDir: process.env.AFK_SESSIONS_DIR ?? '.pi/afk/sessions',
  /** 提交身份（host 后端 spawn env 注入，agent commit 用） */
  gitAuthor: process.env.AFK_GIT_AUTHOR ?? 'afk',
  gitEmail: process.env.AFK_GIT_EMAIL ?? 'afk@hacxy.cn',
  /** 依赖安装命令覆盖（默认按 worktree lockfile 检测） */
  installCmd: process.env.AFK_INSTALL_CMD,
  /** 双超时（秒）：idle = 无事件活动上限；completion = 终态后等待进程退出宽限 */
  idleTimeoutSec: Number(process.env.AFK_IDLE_TIMEOUT_SEC ?? 600),
  completionTimeoutSec: Number(process.env.AFK_COMPLETION_TIMEOUT_SEC ?? 60),
}
