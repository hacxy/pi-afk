// 公共 API 导出（库 + CLI 共用）

// 循环编排
export { runAfkLoop, pickIssue } from './loop.js'
export type { LoopEvent, LoopOptions } from './loop.js'

// 配置
export {
  loadGlobalConfig,
  loadProjectConfig,
  globalConfigPath,
  ensureGlobalDirs,
} from './config.js'
export type { GlobalConfig, ProjectConfig } from './config.js'

// 凭据
export { getDeepseekKey, requireDeepseekKey } from './credentials.js'

// GitHub issues
export {
  listAfkIssues,
  commentOnIssue,
  pushBranch,
  createPullRequest,
  recentRalphCommits,
} from './issues.js'
export type { Issue, PullRequest } from './issues.js'

// 沙箱执行
export { runIssueInSandbox, outcomeSchema } from './sandbox.js'
export type { Outcome, RunIssueOptions, RunIssueResult } from './sandbox.js'

// 提示词
export { promptFilePath, buildIssuePromptArgs } from './prompts.js'

// 日志
export { appendLog } from './log.js'
export type { LogEntry } from './log.js'
