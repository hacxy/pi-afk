/**
 * 配置：全部来自环境变量，带默认值。
 * afk 在目标项目根目录运行（process.cwd() = 目标仓库），所有相对路径基于 cwd。
 */
export const config = {
  /** 工作容器镜像（切片 1 构建） */
  image: process.env.AFK_IMAGE ?? 'pi-workspace',
  /** implementer 模型 */
  model: process.env.AFK_MODEL ?? 'deepseek/deepseek-v4-flash',
  /** planner 模型（默认同 model，可单独用更快的） */
  plannerModel:
    process.env.AFK_PLANNER_MODEL ?? process.env.AFK_MODEL ?? 'deepseek/deepseek-v4-flash',
  /** reviewer 模型（默认同 model，可单独用更稳的） */
  reviewerModel:
    process.env.AFK_REVIEWER_MODEL ?? process.env.AFK_MODEL ?? 'deepseek/deepseek-v4-flash',
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
  /** 运行时产物目录（相对 cwd） */
  worktreesDir: process.env.AFK_WORKTREES_DIR ?? '.afk/worktrees',
  piHomeDir: process.env.AFK_PI_HOME_DIR ?? '.afk/pi-home',
  logsDir: process.env.AFK_LOGS_DIR ?? '.afk/logs',
  /** 容器内 git 提交身份（agent commit 时注入） */
  gitAuthor: process.env.AFK_GIT_AUTHOR ?? 'afk',
  gitEmail: process.env.AFK_GIT_EMAIL ?? 'afk@hacxy.cn',
}
