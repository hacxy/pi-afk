// 公共 API 导出（库 + CLI 共用）

// 循环编排
export { runAfkLoop, pickIssue } from './loop.js'
export type { LoopEvent, LoopOptions } from './loop.js'

// 配置
export { loadGlobalConfig, globalConfigPath, ensureGlobalDirs } from './config.js'
export type { GlobalConfig } from './config.js'

// 凭据
export { getDeepseekKey, requireDeepseekKey } from './credentials.js'

// GitHub issues
export {
  listAfkIssues,
  commentOnIssue,
  commentOnPullRequest,
  pushBranch,
  createPullRequest,
  publishAndMerge,
  buildPresyncConflictComment,
  recentRalphCommits,
} from './issues.js'
export type {
  Issue,
  PullRequest,
  PublishAndMergeOptions,
  PublishAndMergeResult,
  PresyncResult,
} from './issues.js'

// 沙箱执行
export { runIssueInSandbox, outcomeSchema } from './sandbox.js'
export type { Outcome, RunIssueOptions, RunIssueResult } from './sandbox.js'

// 提示词（sandcastle 官方模板协议：项目 .sandcastle/prompt.md > 包内默认）
export {
  promptFilePath,
  projectPromptPath,
  resolvePromptFile,
  ensureProjectPrompt,
  ensureSandcastleGitignore,
  buildIssuePromptArgs,
} from './prompts.js'

// 日志
export { appendLog } from './log.js'
export type { LogEntry } from './log.js'
