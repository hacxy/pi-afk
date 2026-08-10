// 公共 API 导出（库 + CLI 共用）

// 基础工具函数
export function add2(a: number, b: number): number {
  return a + b
}

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
export { getDeepseekKey, getGhToken, requireDeepseekKey } from './credentials.js'

// GitHub issues
export {
  listAfkIssues,
  commentOnIssue,
  closeIssue,
  pushBranch,
  createPullRequest,
  recentRalphCommits,
  repoName,
} from './issues.js'
export type { Issue, PullRequest } from './issues.js'

// 沙箱执行
export { runIssueInSandbox, outcomeSchema } from './sandbox.js'
export type { Outcome, RunIssueOptions, RunIssueResult } from './sandbox.js'

// 提示词
export { promptFilePath, loadPrompt, buildIssuePromptArgs } from './prompts.js'

// 日志
export { appendLog } from './log.js'
export type { LogEntry } from './log.js'
