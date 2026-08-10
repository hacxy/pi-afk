import { join } from 'node:path'

import { LOG_DIR, type GlobalConfig } from './config.js'
import {
  listAfkIssues,
  commentOnIssue,
  publishAndMerge,
  recentRalphCommits,
  fetchOriginMain,
  isHitlIssue,
  type Issue,
} from './issues.js'
import { appendLog } from './log.js'
import { resolvePromptFile, buildIssuePromptArgs } from './prompts.js'
import { runIssueInSandbox, type Outcome } from './sandbox.js'

// ---------------------------------------------------------------------------
// 事件模型：结构化事件数组，为并行与 Web UI 预留
// ---------------------------------------------------------------------------

export type LoopEvent =
  | { type: 'iteration-start'; iteration: number; total: number }
  | { type: 'issue-picked'; issue: Issue }
  | {
      type: 'issue-outcome'
      issue: Issue
      status: Outcome['status']
      summary: string
      commitCount: number
    }
  | { type: 'issue-commented'; issue: Issue; reason: string }
  | { type: 'pull-request'; issue: Issue; url: string; prNumber: number }
  | { type: 'issue-merged'; issue: Issue; prNumber: number }
  | { type: 'no-more-tasks'; hitlPending: number }
  | { type: 'max-iterations-reached'; iteration: number }
  | { type: 'error'; message: string; issue?: Issue }

export interface LoopOptions {
  /** 宿主项目目录（cwd） */
  projectDir: string
  /** 最大迭代数（CLI 参数） */
  iterations: number
  /** 全局配置（含 label） */
  config: GlobalConfig
  /** deepseek key */
  deepseekKey: string
}

// ---------------------------------------------------------------------------
// 选择逻辑（可单测）
// ---------------------------------------------------------------------------

export function pickIssue(issues: Issue[], skipped: Set<number>): Issue | null {
  const candidates = issues
    .filter((i) => !skipped.has(i.number) && !isHitlIssue(i))
    .sort((a, b) => a.number - b.number)
  return candidates[0] ?? null
}

/** 统计待人工处理的 HITL 切片数 */
export function countHitlPending(issues: Issue[]): number {
  return issues.filter(isHitlIssue).length
}

// ---------------------------------------------------------------------------
// 单 issue 处理（纯异步函数，为并行预留——不依赖循环内共享可变状态）
// ---------------------------------------------------------------------------

async function processIssue(issue: Issue, opts: LoopOptions): Promise<LoopEvent[]> {
  const events: LoopEvent[] = []
  const branch = `agent/issue-${issue.number}`

  try {
    const recentCommits = await recentRalphCommits(opts.projectDir)
    const promptArgs = buildIssuePromptArgs({ issue, branch, recentCommits })

    // 宿主先刷新 origin/main，worktree 从最新远端 main 创建（而非过期的本地 HEAD），
    // 新 PR 不再携带已合入 main 的重复提交（hacxy.cn #23 事故）。
    // fetch 失败降级为本地 HEAD 基线并记日志，不阻断流程（sandcastle 非致命哲学）。
    let baseBranch: string | undefined
    try {
      await fetchOriginMain(opts.projectDir)
      baseBranch = 'origin/main'
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      appendLog(LOG_DIR, {
        type: 'fetch-origin-main-failed',
        issueNumber: issue.number,
        message,
      })
    }

    const result = await runIssueInSandbox({
      image: opts.config.image,
      model: opts.config.model,
      deepseekKey: opts.deepseekKey,
      projectDir: opts.projectDir,
      branch,
      baseBranch,
      promptFile: resolvePromptFile(opts.projectDir),
      promptArgs,
      logPath: join(LOG_DIR, `issue-${issue.number}.log`),
    })

    const { outcome } = result
    events.push({
      type: 'issue-outcome',
      issue,
      status: outcome.status,
      summary: outcome.summary,
      commitCount: result.commits.length,
    })

    switch (outcome.status) {
      case 'done': {
        if (result.commits.length === 0) {
          // agent 声称完成但无提交——不推 PR，只留事件，交由用户判断
          events.push({
            type: 'issue-commented',
            issue,
            reason: 'agent 报告 done 但没有任何 commit，未创建 PR',
          })
          break
        }
        // 保守派：宿主统一推送 + 开 PR（凭据不进沙箱）；autoMerge 时由流水线自动 squash 合并
        const { pr, merged } = await publishAndMerge({
          branch,
          title: `fix: issue #${issue.number} ${issue.title}`.slice(0, 100),
          body: `由 Ralph / pi-afk 自动生成\n\n${outcome.summary}\n\nCloses #${issue.number}`,
          projectDir: opts.projectDir,
          autoMerge: opts.config.autoMerge,
        })
        events.push({ type: 'pull-request', issue, url: pr.url, prNumber: pr.number })

        // AFK 切片语义：合并后 GitHub 自动关 issue（合并失败已由流水线重试，重试仍失败抛错）
        if (merged) {
          events.push({ type: 'issue-merged', issue, prNumber: pr.number })
        }
        break
      }
      case 'blocked':
      case 'skipped': {
        await commentOnIssue(
          issue.number,
          `Ralph 未能完成此 issue（status: ${outcome.status}）。原因：\n\n${outcome.summary}`,
        )
        events.push({
          type: 'issue-commented',
          issue,
          reason: `${outcome.status}: ${outcome.summary}`,
        })
        break
      }
    }

    appendLog(LOG_DIR, {
      type: 'issue-result',
      issueNumber: issue.number,
      status: outcome.status,
      summary: outcome.summary,
      commits: result.commits.length,
    })

    return events
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    appendLog(LOG_DIR, { type: 'error', issueNumber: issue.number, message })
    return [{ type: 'error', message, issue }]
  }
}

// ---------------------------------------------------------------------------
// 主循环（串行：一次只处理一个 issue，结果顺序清晰可追踪）
// ---------------------------------------------------------------------------

export async function runAfkLoop(opts: LoopOptions): Promise<LoopEvent[]> {
  const events: LoopEvent[] = []
  const skipped = new Set<number>()

  for (let i = 1; i <= opts.iterations; i++) {
    events.push({ type: 'iteration-start', iteration: i, total: opts.iterations })
    appendLog(LOG_DIR, { type: 'iteration-start', iteration: i })

    let issues: Issue[]
    try {
      issues = await listAfkIssues(opts.config.labels)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      events.push({ type: 'error', message })
      break
    }

    const issue = pickIssue(issues, skipped)
    if (!issue) {
      // 没有可自动处理的 issue 时，告知待人工的 HITL 切片数
      const hitlPending = countHitlPending(issues)
      events.push({ type: 'no-more-tasks', hitlPending })
      appendLog(LOG_DIR, { type: 'no-more-tasks', hitlPending })
      break
    }

    events.push({ type: 'issue-picked', issue })
    appendLog(LOG_DIR, {
      type: 'issue-picked',
      issueNumber: issue.number,
      title: issue.title,
    })

    const issueEvents = await processIssue(issue, opts)
    events.push(...issueEvents)

    // blocked/skipped 的 issue 本轮不再尝试
    const terminal = issueEvents.find(
      (e): e is Extract<LoopEvent, { type: 'issue-outcome' }> => e.type === 'issue-outcome',
    )
    if (terminal && terminal.status !== 'done') {
      skipped.add(issue.number)
    }
  }

  return events
}
