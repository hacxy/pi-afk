import type { Issue } from './issues.js'

import { config } from './config.js'
import { createWorktree, pushBranch, removeWorktree, branchName } from './git.js'
import { addLabel, listTodoIssues, removeLabel } from './issues.js'
import { log, logError } from './log.js'
import { parsePlan, type Plan } from './plan.js'
import { implementerPrompt, plannerPrompt, reviewerPrompt } from './prompts.js'
import { createSandbox, type Sandbox } from './sandbox.js'

export interface IssueResult {
  issue: Issue
  status: 'done' | 'failed'
  error?: string
}

/** planner 结构化输出重试上限（zod 校验不过时在同一容器重跑 planner 阶段） */
const PLAN_MAX_RETRIES = 2

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
  try {
    log(`#${issue.number} 开始（${branch}）`)
    worktree = createWorktree(branch)

    // 常驻容器：每 issue 一个，planner/implementer/reviewer 三阶段 docker exec 复用，依赖只装一次
    sandbox = await createSandbox({
      image: config.image,
      worktree,
      repoRoot: process.cwd(),
      branch,
      installCmd: config.installCmd,
    })
    // onSandboxReady hook：容器就绪即装依赖（agent 不自装，D2）
    await sandbox.installDeps()

    // Phase 1: planner —— 输出结构化 plan（zod 校验 + 重试上限）
    const plan = await planPhase(sandbox, issue, branch, worktree)

    // Phase 2: implementer —— 写代码 + 验证 + 提交
    await stage(
      sandbox,
      worktree,
      branch,
      'implementer',
      config.model,
      implementerPrompt(issue, plan),
    )

    // Phase 3: reviewer —— 审查 + 直接修复 + 提交
    await stage(
      sandbox,
      worktree,
      branch,
      'reviewer',
      config.reviewerModel,
      reviewerPrompt(issue, plan),
    )

    // 宿主 push 分支
    pushBranch(worktree, branch)
    log(`#${issue.number} 已 push → origin/${branch}`)

    // label 状态机：todo → done
    addLabel(issue.number, config.doneLabel)
    removeLabel(issue.number, config.todoLabel)
    log(`#${issue.number} 完成 ✓（label: ${config.todoLabel} → ${config.doneLabel}）`)
    return { issue, status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError(`#${issue.number} 失败：${message}`)
    // label 状态机：todo → failed（手动重置回 todo 才会重跑）
    try {
      addLabel(issue.number, config.failedLabel)
      removeLabel(issue.number, config.todoLabel)
    } catch {
      // label 操作失败不掩盖原始错误
    }
    return { issue, status: 'failed', error: message }
  } finally {
    // 成功/失败都销毁容器（try/finally），无孤儿容器
    if (sandbox) await sandbox.destroy()
    if (worktree) removeWorktree(worktree)
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
      logError(`#${issue.number} planner 输出非法（第 ${attempt + 1} 次）：${lastError}`)
    }
  }
  throw new Error(`planner 重试 ${PLAN_MAX_RETRIES} 次仍无合法 plan：${lastError}`)
}

/** 跑单个阶段：复用常驻容器（docker exec），非零退出即抛错 */
async function stage(
  sandbox: Sandbox,
  worktree: string,
  branch: string,
  stageName: string,
  model: string,
  prompt: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  log(`#${branch.split('/').pop()} ${stageName} 阶段（${model}）…`)
  const result = await sandbox.runStage({ worktree, prompt, model, stage: stageName, branch })
  if (result.exitCode !== 0) {
    throw new Error(`${stageName} 退出码 ${result.exitCode}\nstderr: ${result.stderr.slice(-2000)}`)
  }
  return result
}
