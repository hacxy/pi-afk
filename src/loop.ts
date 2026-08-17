import type { Config } from './config.js'
import type { Issue } from './issues.js'

import { isAbsolute, relative } from 'node:path'
import pMap from 'p-map'

import { HostExecutor, type StageResult } from './executor.js'
import {
  archiveWorktree,
  branchName,
  conflictedFiles,
  createWorktree,
  deleteBranch,
  fetchBase,
  hasRemoteBranch,
  mergeBaseIntoBranch,
  pushBranch,
  removeWorktree,
} from './git.js'
import { installDeps } from './install.js'
import {
  addComment,
  addLabel,
  listTodoIssues,
  mergePr,
  openPr,
  prComment,
  removeLabel,
  repoName,
  waitForChecksPass,
} from './issues.js'
import { beginIssueLog, log, logError, type IssueLogger } from './log.js'
import { implementerFixPrompt, implementerPrompt, mergerPrompt, reviewerPrompt } from './prompts.js'
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

/** 心跳间隔：长 implementer 静默期终端仍有「还在跑」信号（宿主 timer，与 watchdog 无关） */
const HEARTBEAT_MS = 60_000

/**
 * merge 串行队列（Q8）：批内并发 issue 的合并阶段共享同一队列，一次一个。
 * 前一个失败（reject）不影响后续排队任务（tail 用 .then(fn, fn) 接力）。
 */
class MergeQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

/**
 * 无人值守循环（模型 A：迭代 = 一批并发任务）：
 * 每次迭代原子拉取一批（≤ maxParallel 个）待处理 issue 并批内并发处理到终态，
 * 共迭代 maxIterations 次（默认 1）；批间重拉天然推进（已完成 issue 的 label 已
 * 翻转，不会被重复选中），无需 in-progress 状态；seen 集合兜底 label 翻转失败时
 * 防同批重选死循环。
 */
export async function runAfk(config: Config, maxIterations = 1): Promise<IssueResult[]> {
  const iterations = Math.max(1, Math.floor(maxIterations))
  const results: IssueResult[] = []
  const seen = new Set<number>()
  const mergeQueue = new MergeQueue()

  for (let iter = 0; iter < iterations; iter++) {
    let issues: Issue[]
    try {
      issues = await listTodoIssues(config)
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

    // 基线每迭代只 fetch 一次（串行）：批内并发 issue 不再各自 fetch origin/main，
    // 消除同仓库并发 fetch 撞 ref 事务锁的竞态（issue #74）；失败 = 宿主级故障，中止本轮
    let baseSha: string
    try {
      baseSha = await fetchBase(config)
    } catch (error) {
      logError(`fetch 基线失败：${error instanceof Error ? error.message : error}`)
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
          return await processIssue(config, issue, baseSha, mergeQueue)
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

async function processIssue(
  config: Config,
  issue: Issue,
  baseSha: string,
  mergeQueue: MergeQueue,
): Promise<IssueResult> {
  const logger = beginIssueLog(issue.number, config.logsDir)
  const branch = branchName(config, issue)
  let worktree: string | undefined
  let worktreeArchived = false
  let currentStage = 'git'
  try {
    logger.log(`开始（${branch}）`)
    worktree = await createWorktree(config, branch, baseSha)

    // 宿主侧装依赖（编排层负责，agent 不自装）
    currentStage = 'install'
    await installDeps(worktree, config, logger.log)

    // 单阶段 implementer：写代码 + 验证 + 提交
    currentStage = 'implementer'
    await implementerPhase(config, worktree, branch, issue, logger)

    // 宿主 push 分支（重跑场景远端有残留 → force-with-lease 覆盖，Q7）
    currentStage = 'push'
    await pushBranch(worktree, branch, { force: await hasRemoteBranch(branch) })
    logger.log(`已 push → origin/${branch}`)

    // 开 PR（body 带 Closes #N，合并时 GitHub 自动关 issue）
    currentStage = 'pr'
    // GitHub issue/PR 共享编号命名空间：PR 编号 ≠ issue 编号，后续 PR 操作用 pr.number
    const pr = await openPr({
      branch,
      base: config.baseBranch,
      title: issue.title,
      body: prBody(issue),
    })
    logger.log(`PR 已开 → ${pr.url}`)

    // codereview：同一 worktree、新会话，review 循环（≤ maxReviewRounds 轮）
    currentStage = 'review'
    const reviewRounds = await reviewLoop(config, worktree, branch, pr.number, issue, logger)
    logger.log(`review ${reviewRounds} 轮通过`)

    // 合并 PR（autoMerge opt-in；宿主串行队列内 fetch 最新 base + 化解冲突）
    let merged = false
    if (config.autoMerge) {
      currentStage = 'merge'
      // 闭包内 worktree 被悲观收窄为 string | undefined，先拷贝为确定值
      const wt = worktree
      await mergeQueue.run(() => mergePhase(config, wt, branch, pr.number, issue, logger))
      merged = true
      logger.log(`已合并 → ${pr.url}`)
      await tryReport(logger, () => addLabel(issue.number, config.mergedLabel), `加 merged label`)
    }

    // 成功回报 + label 状态机：todo → done
    await tryReport(
      logger,
      async () =>
        addComment(
          issue.number,
          successComment({
            branch,
            prUrl: pr.url,
            compareUrl: compareUrl(await repoName(), config.baseBranch, branch),
            merged,
            reviewRounds,
          }),
        ),
      `成功回报`,
    )
    await tryReport(logger, () => addLabel(issue.number, config.doneLabel), `加 done label`)
    await tryReport(logger, () => removeLabel(issue.number, config.todoLabel), `移除 todo label`)
    logger.log(`完成 ✓（label: ${config.todoLabel} → ${config.doneLabel}）`)
    return { issue, status: 'done' }
  } catch (error) {
    const info = failureInfo(error, currentStage)
    const message = error instanceof Error ? error.message : String(error)
    logger.logError(`失败：${message}`)

    // 失败现场归档 + 删本地分支（改回 todo 重跑不被残留卡住）
    const archivePath = worktree ? await archiveWorktree(config, worktree, branch) : undefined
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
      `失败回报`,
    )

    // label 状态机：todo → failed（手动重置回 todo 才会重跑）
    await tryReport(logger, () => addLabel(issue.number, config.failedLabel), `加 failed label`)
    await tryReport(logger, () => removeLabel(issue.number, config.todoLabel), `移除 todo label`)
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
 * 通用 agent 阶段（implementer/reviewer/fixer/merger 共用）：宿主 spawn pi，
 * agent 正文增量落盘 issue 日志（不进终端）。关键信息：开场 log 路径（可 tail）、
 * 心跳、阶段结束 + 退出码 + 耗时 + 输出量 + 超时 + session id；
 * agent 完整事件流留在 session 文件（stage 带轮次后缀避免覆盖）。
 */
async function runAgentPhase(
  config: Config,
  worktree: string,
  branch: string,
  issue: Issue,
  logger: IssueLogger,
  opts: { stage: string; prompt: string; model: string; label: string },
): Promise<StageResult> {
  logger.log(`${opts.label}（${opts.model}）… log: ${reportPath(logger.file)}`)
  const startedAt = Date.now()
  // 心跳：长静默期终端仍有「还在跑」信号（宿主 timer，与 watchdog 无关）
  const heartbeat = setInterval(() => {
    logger.log(`${opts.label} 运行中 ${Math.round((Date.now() - startedAt) / 1000)}s…`)
  }, HEARTBEAT_MS)
  let result: StageResult
  try {
    result = await new HostExecutor(config).runStage(
      {
        prompt: opts.prompt,
        model: opts.model,
        stage: opts.stage,
        branch,
        cwd: worktree,
      },
      // B 方案：agent 正文不进终端，增量落盘 issue log（行缓冲，完整行才写）
      { onText: (delta) => logger.logAgent(delta) },
    )
  } finally {
    clearInterval(heartbeat)
    logger.flushAgent()
  }
  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  const outputKb = (Buffer.byteLength(result.stdout, 'utf8') / 1024).toFixed(0)
  logger.log(
    `${opts.label} 结束：退出码 ${result.exitCode}${result.timedOut ? '（超时）' : ''}，耗时 ${durationSec}s，输出 ${outputKb}KB`,
  )
  if (result.sessionId) logger.log(`session: ${result.sessionId}`)
  return result
}

/** 单阶段 implementer：写代码 + 验证 + 提交；非零退出抛带结构的 StageFailure */
async function implementerPhase(
  config: Config,
  worktree: string,
  branch: string,
  issue: Issue,
  logger: IssueLogger,
): Promise<void> {
  const result = await runAgentPhase(config, worktree, branch, issue, logger, {
    stage: 'implementer',
    prompt: implementerPrompt(issue, branch),
    model: config.model,
    label: 'implementer 阶段',
  })
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

/**
 * review 循环（≤ maxReviewRounds 轮）：同一 worktree、每轮新会话。
 * reviewer 输出 <verdict>approve|request-changes</verdict> 结构化结论；
 * request-changes → 反馈发 PR comment → fixer 新会话修复 → push → 复审。
 * 返回通过的轮数；耗尽仍不通过 → 抛错走失败路径（PR/远端保留，人工可接手）。
 * prNumber：PR 编号（≠ issue 编号，GitHub 共享命名空间）。
 */
async function reviewLoop(
  config: Config,
  worktree: string,
  branch: string,
  prNumber: number,
  issue: Issue,
  logger: IssueLogger,
): Promise<number> {
  const model = config.reviewerModel || config.model
  for (let round = 1; round <= config.maxReviewRounds; round++) {
    const review = await runAgentPhase(config, worktree, branch, issue, logger, {
      stage: `reviewer-${round}`,
      prompt: reviewerPrompt(issue, branch, config.baseBranch),
      model,
      label: `reviewer 阶段 第${round}轮`,
    })
    if (review.exitCode !== 0) {
      throw new StageFailure(
        'reviewer',
        review.exitCode,
        review.stderr,
        review.sessionFile,
        review.timedOut,
      )
    }
    if (parseVerdict(review.stdout) === 'approve') return round

    // request-changes：反馈 → PR comment + fixer 修复 → push → 复审
    const feedback = review.stdout.trim()
    if (round >= config.maxReviewRounds) {
      throw new Error(`review 第 ${round} 轮仍未通过（maxReviewRounds=${config.maxReviewRounds}）`)
    }
    await tryReport(
      logger,
      () => prComment(prNumber, `🔍 afk review 第 ${round} 轮：需修复\n\n${feedback}`),
      `review 反馈发 PR`,
    )
    const fix = await runAgentPhase(config, worktree, branch, issue, logger, {
      stage: `fixer-${round}`,
      prompt: implementerFixPrompt(issue, branch, feedback),
      model: config.model,
      label: `fixer 阶段 第${round}轮`,
    })
    if (fix.exitCode !== 0) {
      throw new StageFailure('fixer', fix.exitCode, fix.stderr, fix.sessionFile, fix.timedOut)
    }
    await pushBranchRetry(worktree, branch)
  }
  // 不可达：round 达到上限且未通过时上面已抛
  return config.maxReviewRounds
}

/** 提取 <verdict> 结构化结论；缺失/非法按 request-changes（保守，原文留给 fixer） */
function parseVerdict(stdout: string): 'approve' | 'request-changes' {
  const m = stdout.match(/<verdict>\s*(approve|request-changes)\s*<\/verdict>/)
  return m && m[1] === 'approve' ? 'approve' : 'request-changes'
}

/** push 重试：普通 push 失败（非快进等）→ force-with-lease 覆盖（修复/化解后应 fast-forward，兜底） */
async function pushBranchRetry(path: string, branch: string): Promise<void> {
  try {
    await pushBranch(path, branch)
  } catch {
    await pushBranch(path, branch, { force: true })
  }
}

/**
 * 合并阶段（宿主串行队列内调用，一次一个 PR）：
 * ① 锁内 fetch 最新 base（批内其他 PR 合并后 base 已推进）
 * ② 把 base merge 进分支：干净 → push；冲突 → merger agent 化解 + 提交 + push（≤ conflictTries 次）
 * ③ 等 checks（waitForChecks，超时 mergeTimeoutSec）→ gh pr merge --squash --delete-branch
 * 任一步失败/耗尽 → 抛错走 issue 失败路径（PR/远端分支保留，人工可接手）。
 * prNumber：PR 编号（≠ issue 编号，GitHub 共享命名空间）。
 */
async function mergePhase(
  config: Config,
  worktree: string,
  branch: string,
  prNumber: number,
  issue: Issue,
  logger: IssueLogger,
): Promise<void> {
  await fetchBase(config) // 串行段：合并前拿最新 base（worktree 共享宿主 refs）
  for (let attempt = 1; attempt <= config.conflictTries; attempt++) {
    const clean = await mergeBaseIntoBranch(worktree, branch, config.baseBranch)
    if (!clean) {
      // 冲突：merger agent 化解（同一 worktree、新会话）
      const files = await conflictedFiles(worktree)
      logger.log(
        `合并冲突（第 ${attempt} 次尝试）：${files.join('、') || '见 git status'} → merger agent`,
      )
      const merge = await runAgentPhase(config, worktree, branch, issue, logger, {
        stage: `merger-${attempt}`,
        prompt: mergerPrompt(issue, branch, config.baseBranch, files),
        model: config.model,
        label: `merger 阶段 第${attempt}次`,
      })
      if (merge.exitCode !== 0) {
        throw new StageFailure(
          'merger',
          merge.exitCode,
          merge.stderr,
          merge.sessionFile,
          merge.timedOut,
        )
      }
    }
    // 同步后分支 HEAD 前进（merge commit / 化解提交），push 让 GitHub 重新评估 PR
    await pushBranchRetry(worktree, branch)

    if (config.waitForChecks) {
      logger.log(`等 checks（超时 ${config.mergeTimeoutSec}s）…`)
      const state = await waitForChecksPass(prNumber, config.mergeTimeoutSec)
      if (state === 'fail') throw new Error(`PR checks 失败（PR #${prNumber}）`)
      if (state === 'timeout')
        throw new Error(`等 checks 超时（${config.mergeTimeoutSec}s，PR #${prNumber}）`)
    }
    try {
      await mergePr(prNumber)
      logger.log(`PR #${prNumber} 已合并（squash，远端分支已删）`)
      return
    } catch (error) {
      if (attempt >= config.conflictTries) {
        throw new Error(
          `合并失败（已尝试 ${attempt} 次）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      logger.log(
        `合并未通过（第 ${attempt} 次）：${error instanceof Error ? error.message : String(error)} → 重新同步 base`,
      )
    }
  }
}
