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
import { beginIssueLog, log, logError, type IssueLogger } from './log.js'
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

/**
 * 无人值守循环（模型 A：迭代 = 一批并发任务）：
 * 每次迭代原子拉取一批（≤ maxParallel 个）待处理 issue 并批内并发处理到终态，
 * 共迭代 maxIterations 次（默认 1）；批间重拉天然推进（已完成 issue 的 label 已
 * 翻转，不会被重复选中），无需 in-progress 状态；seen 集合兜底 label 翻转失败时
 * 防同批重选死循环。
 */
export async function runAfk(maxIterations = 1): Promise<IssueResult[]> {
  const iterations = Math.max(1, Math.floor(maxIterations))
  const results: IssueResult[] = []
  const seen = new Set<number>()

  for (let iter = 0; iter < iterations; iter++) {
    let issues: Issue[]
    try {
      issues = await listTodoIssues()
    } catch (error) {
      logError(`拉取 issue 失败：${error instanceof Error ? error.message : error}`)
      break
    }
    if (issues.length === 0) {
      if (results.length === 0) log(`没有待处理 issue（label=${config.todoLabel}），结束`)
      break
    }
    const fresh = issues.filter((i) => !seen.has(i.number))
    if (fresh.length === 0) {
      logError('剩余待处理 issue 均已被本轮处理（label 可能未翻转，待办无法推进），提前结束')
      break
    }

    // 一次迭代 = 一批（≤ maxParallel 个）并发处理到终态
    const batch = fresh.slice(0, config.maxParallel)
    for (const i of batch) seen.add(i.number)
    log(
      `迭代 ${iter + 1}/${iterations}：处理 ${batch.length} 个待处理 issue（${batch.map((i) => `#${i.number}`).join('、')}）`,
    )

    // 批内并发（batch.length ≤ maxParallel）：单个 issue 意外异常不影响同批其他 issue
    const batchResults = await pMap<Issue, IssueResult>(
      batch,
      async (issue): Promise<IssueResult> => {
        try {
          return await processIssue(issue)
        } catch (error) {
          logError(`#${issue.number} 处理异常：${error instanceof Error ? error.message : error}`)
          return { issue, status: 'failed', error: String(error) }
        }
      },
      { concurrency: batch.length },
    )
    results.push(...batchResults)
  }
  return results
}

async function processIssue(issue: Issue): Promise<IssueResult> {
  const logger = beginIssueLog(issue.number)
  const branch = branchName(issue)
  let worktree: string | undefined
  let worktreeArchived = false
  let currentStage = 'git'
  try {
    logger.log(`#${issue.number} 开始（${branch}）`)
    worktree = await createWorktree(branch)

    // 宿主侧装依赖（编排层负责，agent 不自装）
    currentStage = 'install'
    await installDeps(worktree, logger.log)

    // 单阶段 implementer：写代码 + 验证 + 提交
    currentStage = 'implementer'
    await implementerPhase(worktree, branch, issue, logger)

    // 宿主 push 分支
    currentStage = 'push'
    await pushBranch(worktree, branch)
    logger.log(`#${issue.number} 已 push → origin/${branch}`)

    // 开 PR（body 带 Closes #N，人工 merge 时 GitHub 自动关 issue）
    currentStage = 'pr'
    const prUrl = await openPr({
      branch,
      base: config.baseBranch,
      title: issue.title,
      body: prBody(issue),
    })
    logger.log(`#${issue.number} PR 已开 → ${prUrl}`)

    // 成功回报 + label 状态机：todo → done
    await tryReport(
      logger,
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
      logger,
      () => addLabel(issue.number, config.doneLabel),
      `#${issue.number} 加 done label`,
    )
    await tryReport(
      logger,
      () => removeLabel(issue.number, config.todoLabel),
      `#${issue.number} 移除 todo label`,
    )
    logger.log(`#${issue.number} 完成 ✓（label: ${config.todoLabel} → ${config.doneLabel}）`)
    return { issue, status: 'done' }
  } catch (error) {
    const info = failureInfo(error, currentStage)
    const message = error instanceof Error ? error.message : String(error)
    logger.logError(`#${issue.number} 失败：${message}`)

    // 失败现场归档 + 删本地分支（改回 todo 重跑不被残留卡住）
    const archivePath = worktree ? await archiveWorktree(worktree, branch) : undefined
    if (archivePath) worktreeArchived = true
    await deleteBranch(branch)

    // 失败回报：阶段 + 退出码 + stderr 摘要 + 产物路径 + 重跑提示（best-effort）
    await tryReport(
      logger,
      async () =>
        addComment(
          issue.number,
          failureComment({
            stage: info.stage,
            exitCode: info.exitCode,
            stderr: info.stderr,
            timedOut: info.timedOut,
            logPath: reportPath(logger.file),
            sessionPath: reportPath(info.sessionFile),
            archivePath: reportPath(archivePath),
            todoLabel: config.todoLabel,
          }),
        ),
      `#${issue.number} 失败回报`,
    )

    // label 状态机：todo → failed（手动重置回 todo 才会重跑）
    await tryReport(
      logger,
      () => addLabel(issue.number, config.failedLabel),
      `#${issue.number} 加 failed label`,
    )
    await tryReport(
      logger,
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
async function tryReport(
  logger: IssueLogger,
  fn: () => Promise<void>,
  context: string,
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    logger.logError(`${context} 失败：${error instanceof Error ? error.message : error}`)
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

/**
 * 单阶段 implementer：宿主 spawn pi，实时透传，非零退出抛带结构的 StageFailure。
 * 关键信息（A14）：阶段结束 + 退出码 + 耗时 + 超时 + session id 记入 issue 日志；
 * agent 完整事件流留在 session 文件，不重复落盘。
 */
async function implementerPhase(
  worktree: string,
  branch: string,
  issue: Issue,
  logger: IssueLogger,
): Promise<void> {
  logger.log(`#${branch.split('/').pop()} implementer 阶段（${config.model}）…`)
  const startedAt = Date.now()
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
  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  logger.log(
    `implementer 结束：退出码 ${result.exitCode}${result.timedOut ? '（超时）' : ''}，耗时 ${durationSec}s`,
  )
  if (result.sessionId) logger.log(`session: ${result.sessionId}`)
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
