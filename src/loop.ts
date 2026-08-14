import type { Issue } from './issues.js'

import { isAbsolute, relative } from 'node:path'
import pMap from 'p-map'

import { config } from './config.js'
import { HostExecutor } from './executor.js'
import {
  archiveWorktree,
  branchName,
  createWorktree,
  deleteBranch,
  pushBranch,
  removeWorktree,
} from './git.js'
import { installDeps } from './install.js'
import { addComment, addLabel, listTodoIssues, openPr, removeLabel, repoName } from './issues.js'
import { currentLogFile, log, logError } from './log.js'
import { implementerPrompt } from './prompts.js'
import { compareUrl, failureComment, successComment } from './report.js'

export interface IssueResult {
  issue: Issue
  status: 'done' | 'failed'
  error?: string
}

/** 阶段失败（带结构化回报信息）：implementer 非零退出 / 超时 */
class StageFailure extends Error {
  constructor(
    readonly stage: string,
    readonly exitCode: number,
    readonly stderr: string,
    readonly sessionFile: string,
    readonly timedOut: boolean,
  ) {
    super(
      `${stage} 退出码 ${exitCode}${timedOut ? '（超时）' : ''}\nstderr: ${stderr.slice(-2000)}`,
    )
    this.name = 'StageFailure'
  }
}

/** 回报用相对路径：绝对路径相对 cwd 收缩，仓库内产物可读且不泄露宿主路径 */
function reportPath(p: string | undefined): string | undefined {
  if (!p) return undefined
  if (!isAbsolute(p)) return p
  const rel = relative(process.cwd(), p)
  return rel.startsWith('..') ? p : rel
}

export async function runAfk(): Promise<IssueResult[]> {
  let issues: Issue[]
  try {
    issues = await listTodoIssues()
  } catch (error) {
    logError(`拉取 issue 失败：${error instanceof Error ? error.message : error}`)
    return []
  }
  log(`拉取到 ${issues.length} 个待处理 issue（label=${config.todoLabel}）`)
  if (issues.length === 0) return []

  // p-map 并发（MAX_PARALLEL）：单个 issue 意外异常不影响其他 issue
  return pMap(
    issues,
    async (issue) => {
      try {
        return await processIssue(issue)
      } catch (error) {
        logError(`#${issue.number} 处理异常：${error instanceof Error ? error.message : error}`)
        return { issue, status: 'failed', error: String(error) }
      }
    },
    { concurrency: config.maxParallel },
  )
}

async function processIssue(issue: Issue): Promise<IssueResult> {
  const branch = branchName(issue)
  let worktree: string | undefined
  let worktreeArchived = false
  let currentStage = 'git'
  try {
    log(`#${issue.number} 开始（${branch}）`)
    worktree = await createWorktree(branch)

    // 宿主侧装依赖（编排层负责，agent 不自装）
    currentStage = 'install'
    await installDeps(worktree)

    // 单阶段 implementer：写代码 + 验证 + 提交
    currentStage = 'implementer'
    await implementerPhase(worktree, branch, issue)

    // 宿主 push 分支
    currentStage = 'push'
    await pushBranch(worktree, branch)
    log(`#${issue.number} 已 push → origin/${branch}`)

    // 开 PR（body 带 Closes #N，人工 merge 时 GitHub 自动关 issue）
    currentStage = 'pr'
    const prUrl = await openPr({
      branch,
      base: config.baseBranch,
      title: issue.title,
      body: prBody(issue),
    })
    log(`#${issue.number} PR 已开 → ${prUrl}`)

    // 成功回报 + label 状态机：todo → done
    await tryReport(
      async () =>
        addComment(
          issue.number,
          successComment({
            branch,
            prUrl,
            compareUrl: compareUrl(await repoName(), config.baseBranch, branch),
          }),
        ),
      `#${issue.number} 成功回报`,
    )
    await tryReport(
      () => addLabel(issue.number, config.doneLabel),
      `#${issue.number} 加 done label`,
    )
    await tryReport(
      () => removeLabel(issue.number, config.todoLabel),
      `#${issue.number} 移除 todo label`,
    )
    log(`#${issue.number} 完成 ✓（label: ${config.todoLabel} → ${config.doneLabel}）`)
    return { issue, status: 'done' }
  } catch (error) {
    const info = failureInfo(error, currentStage)
    const message = error instanceof Error ? error.message : String(error)
    logError(`#${issue.number} 失败：${message}`)

    // 失败现场归档 + 删本地分支（改回 todo 重跑不被残留卡住）
    const archivePath = worktree ? await archiveWorktree(worktree, branch) : undefined
    if (archivePath) worktreeArchived = true
    await deleteBranch(branch)

    // 失败回报：阶段 + 退出码 + stderr 摘要 + 产物路径 + 重跑提示（best-effort）
    await tryReport(
      async () =>
        addComment(
          issue.number,
          failureComment({
            stage: info.stage,
            exitCode: info.exitCode,
            stderr: info.stderr,
            timedOut: info.timedOut,
            logPath: reportPath(currentLogFile()),
            sessionPath: reportPath(info.sessionFile),
            archivePath: reportPath(archivePath),
            todoLabel: config.todoLabel,
          }),
        ),
      `#${issue.number} 失败回报`,
    )

    // label 状态机：todo → failed（手动重置回 todo 才会重跑）
    await tryReport(
      () => addLabel(issue.number, config.failedLabel),
      `#${issue.number} 加 failed label`,
    )
    await tryReport(
      () => removeLabel(issue.number, config.todoLabel),
      `#${issue.number} 移除 todo label`,
    )
    return { issue, status: 'failed', error: message }
  } finally {
    // 成功路径：删 worktree + 删本地分支（远程分支留给 PR）；失败路径已在 catch 归档并删分支
    if (worktree && !worktreeArchived) {
      await removeWorktree(worktree)
      await deleteBranch(branch)
    }
  }
}

/** PR body：Closes #N + issue 原文 */
function prBody(issue: Issue): string {
  return [`Closes #${issue.number}`, '', issue.body].join('\n')
}

/** gh 写操作 best-effort：回报/label 失败只记日志，不翻转 issue 结果 */
async function tryReport(fn: () => Promise<void>, context: string): Promise<void> {
  try {
    await fn()
  } catch (error) {
    logError(`${context} 失败：${error instanceof Error ? error.message : error}`)
  }
}

/** 从抛错提取结构化失败信息；非 StageFailure 用当前阶段 + 退出码 1 + message 兜底 */
function failureInfo(
  error: unknown,
  fallbackStage: string,
): {
  stage: string
  exitCode: number
  stderr: string
  sessionFile?: string
  timedOut?: boolean
} {
  if (error instanceof StageFailure) {
    return {
      stage: error.stage,
      exitCode: error.exitCode,
      stderr: error.stderr,
      sessionFile: error.sessionFile,
      timedOut: error.timedOut,
    }
  }
  return {
    stage: fallbackStage,
    exitCode: 1,
    stderr: error instanceof Error ? error.message : String(error),
  }
}

/** 单阶段 implementer：宿主 spawn pi，实时透传，非零退出抛带结构的 StageFailure */
async function implementerPhase(worktree: string, branch: string, issue: Issue): Promise<void> {
  log(`#${branch.split('/').pop()} implementer 阶段（${config.model}）…`)
  const result = await new HostExecutor().runStage(
    {
      prompt: implementerPrompt(issue, branch),
      model: config.model,
      stage: 'implementer',
      branch,
      cwd: worktree,
    },
    { onText: (delta) => process.stdout.write(delta) },
  )
  if (result.exitCode !== 0) {
    throw new StageFailure(
      'implementer',
      result.exitCode,
      result.stderr,
      result.sessionFile,
      result.timedOut,
    )
  }
}
