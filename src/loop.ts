import type { Issue } from './issues.js'

import { isAbsolute, relative } from 'node:path'

import { config } from './config.js'
import {
  archiveWorktree,
  branchName,
  createWorktree,
  deleteBranch,
  pushBranch,
  removeWorktree,
} from './git.js'
import { addComment, addLabel, listTodoIssues, removeLabel, repoName } from './issues.js'
import { currentLogFile, log, logError } from './log.js'
import { parsePlan, type Plan } from './plan.js'
import { implementerPrompt, plannerPrompt, reviewerPrompt } from './prompts.js'
import { compareUrl, failureComment, successComment } from './report.js'
import { createSandbox, type Sandbox } from './sandbox.js'

export interface IssueResult {
  issue: Issue
  status: 'done' | 'failed'
  error?: string
}

/** planner 结构化输出重试上限（zod 校验不过时在同一容器重跑 planner 阶段） */
const PLAN_MAX_RETRIES = 2

/** 阶段失败（带结构化回报信息）：agent 阶段非零退出 / 超时 / planner 校验耗尽 */
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
    issues = listTodoIssues()
  } catch (error) {
    logError(`拉取 issue 失败：${error instanceof Error ? error.message : error}`)
    return []
  }
  log(`拉取到 ${issues.length} 个待处理 issue（label=${config.todoLabel}）`)
  if (issues.length === 0) return []

  // 信号量并发（与 sandcastle 一致的 MAX_PARALLEL）
  let running = 0
  const queue: (() => void)[] = []
  const acquire = (): Promise<void> =>
    running < config.maxParallel
      ? (running++, Promise.resolve())
      : new Promise<void>((resolvePromise) => queue.push(resolvePromise))
  const release = (): void => {
    running--
    queue.shift()?.()
  }

  const results = await Promise.all(
    issues.map(async (issue): Promise<IssueResult> => {
      await acquire()
      try {
        return await processIssue(issue)
      } catch (error) {
        logError(`#${issue.number} 处理异常：${error instanceof Error ? error.message : error}`)
        return { issue, status: 'failed', error: String(error) }
      } finally {
        release()
      }
    }),
  )
  return results
}

async function processIssue(issue: Issue): Promise<IssueResult> {
  const branch = branchName(issue)
  let worktree: string | undefined
  let sandbox: Sandbox | undefined
  let worktreeArchived = false
  let currentStage = 'git'
  try {
    log(`#${issue.number} 开始（${branch}）`)
    worktree = createWorktree(branch)

    // 常驻容器：每 issue 一个，planner/implementer/reviewer 三阶段 docker exec 复用，依赖只装一次
    currentStage = 'sandbox'
    sandbox = await createSandbox({
      image: config.image,
      worktree,
      repoRoot: process.cwd(),
      branch,
      installCmd: config.installCmd,
    })

    // onSandboxReady hook：容器就绪即装依赖（agent 不自装，D2）
    currentStage = 'install'
    await sandbox.installDeps()

    // Phase 1: planner —— 输出结构化 plan（zod 校验 + 重试上限）
    currentStage = 'planner'
    const plan = await planPhase(sandbox, issue, branch, worktree)

    // Phase 2: implementer —— 写代码 + 验证 + 提交
    currentStage = 'implementer'
    await stage(
      sandbox,
      worktree,
      branch,
      'implementer',
      config.model,
      implementerPrompt(issue, plan),
    )

    // Phase 3: reviewer —— 审查 + 直接修复 + 提交
    currentStage = 'reviewer'
    await stage(
      sandbox,
      worktree,
      branch,
      'reviewer',
      config.reviewerModel,
      reviewerPrompt(issue, plan),
    )

    // 宿主 push 分支
    currentStage = 'push'
    pushBranch(worktree, branch)
    log(`#${issue.number} 已 push → origin/${branch}`)

    // 成功回报：分支名 + compare 链接（best-effort，不翻脸）
    tryReport(
      () =>
        addComment(
          issue.number,
          successComment({
            branch,
            compareUrl: compareUrl(repoName(), config.baseBranch, branch),
          }),
        ),
      `#${issue.number} 成功回报`,
    )

    // label 状态机：todo → done
    tryReport(() => addLabel(issue.number, config.doneLabel), `#${issue.number} 加 done label`)
    tryReport(() => removeLabel(issue.number, config.todoLabel), `#${issue.number} 移除 todo label`)
    log(`#${issue.number} 完成 ✓（label: ${config.todoLabel} → ${config.doneLabel}）`)
    return { issue, status: 'done' }
  } catch (error) {
    const info = failureInfo(error, currentStage)
    const message = error instanceof Error ? error.message : String(error)
    logError(`#${issue.number} 失败：${message}`)

    // 失败现场归档 + 删本地分支（改回 todo 重跑不被残留卡住）
    const archivePath = worktree ? archiveWorktree(worktree, branch) : undefined
    if (archivePath) worktreeArchived = true
    deleteBranch(branch)

    // 失败回报：阶段 + 退出码 + stderr 摘要 + 产物路径 + 重跑提示（best-effort）
    tryReport(
      () =>
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
    tryReport(() => addLabel(issue.number, config.failedLabel), `#${issue.number} 加 failed label`)
    tryReport(() => removeLabel(issue.number, config.todoLabel), `#${issue.number} 移除 todo label`)
    return { issue, status: 'failed', error: message }
  } finally {
    // 成功/失败都销毁容器（try/finally），无孤儿容器
    if (sandbox) await sandbox.destroy()
    // 成功路径：删 worktree + 删本地分支；失败路径已在 catch 归档并删分支
    if (worktree && !worktreeArchived) {
      removeWorktree(worktree)
      deleteBranch(branch)
    }
  }
}

/** gh 写操作 best-effort：回报/label 失败只记日志，不翻转 issue 结果 */
function tryReport(fn: () => void, context: string): void {
  try {
    fn()
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

/** planner 阶段：重跑直到拿到合法 plan（上限 PLAN_MAX_RETRIES） */
async function planPhase(
  sandbox: Sandbox,
  issue: Issue,
  branch: string,
  worktree: string,
): Promise<Plan> {
  let lastError = ''
  let lastSession = ''
  for (let attempt = 0; attempt <= PLAN_MAX_RETRIES; attempt++) {
    const result = await stage(
      sandbox,
      worktree,
      branch,
      'planner',
      config.plannerModel,
      plannerPrompt(issue, branch),
    )
    try {
      return parsePlan(result.stdout)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      lastSession = result.sessionFile
      logError(`#${issue.number} planner 输出非法（第 ${attempt + 1} 次）：${lastError}`)
    }
  }
  throw new StageFailure('planner', 1, lastError, lastSession, false)
}

/** 跑单个阶段：复用常驻容器（docker exec），非零退出即抛带结构的 StageFailure */
async function stage(
  sandbox: Sandbox,
  worktree: string,
  branch: string,
  stageName: string,
  model: string,
  prompt: string,
): Promise<{
  stdout: string
  stderr: string
  exitCode: number
  sessionFile: string
  timedOut: boolean
}> {
  log(`#${branch.split('/').pop()} ${stageName} 阶段（${model}）…`)
  const result = await sandbox.runStage({ worktree, prompt, model, stage: stageName, branch })
  if (result.exitCode !== 0) {
    throw new StageFailure(
      stageName,
      result.exitCode,
      result.stderr,
      result.sessionFile,
      result.timedOut,
    )
  }
  return result
}
