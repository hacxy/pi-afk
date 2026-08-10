import type { GlobalConfig } from './config.js'

import { join } from 'node:path'

import {
  listAfkIssues,
  commentOnIssue,
  createPullRequest,
  pushBranch,
  recentRalphCommits,
  type Issue,
} from './issues.js'
import { appendLog } from './log.js'
import { promptFilePath, buildIssuePromptArgs } from './prompts.js'
import { runIssueInSandbox, type Outcome } from './sandbox.js'

// ---------------------------------------------------------------------------
// 事件模型（共识 F3：结构化事件数组，为并行与 Web UI 预留）
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
  | { type: 'no-more-tasks' }
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
    .filter((i) => !skipped.has(i.number))
    .sort((a, b) => a.number - b.number)
  return candidates[0] ?? null
}

// ---------------------------------------------------------------------------
// 单 issue 处理（纯异步函数，为并行预留——不依赖循环内共享可变状态）
// ---------------------------------------------------------------------------

async function processIssue(issue: Issue, opts: LoopOptions): Promise<LoopEvent[]> {
  const events: LoopEvent[] = []
  const branch = `agent/issue-${issue.number}`
  const logDir = opts.config.logDir

  try {
    const recentCommits = await recentRalphCommits(opts.projectDir)
    const promptArgs = buildIssuePromptArgs({ issue, branch, recentCommits })

    const result = await runIssueInSandbox({
      image: opts.config.image,
      model: opts.config.model,
      deepseekKey: opts.deepseekKey,
      projectDir: opts.projectDir,
      branch,
      promptFile: promptFilePath(),
      promptArgs,
      logPath: join(logDir, `issue-${issue.number}.log`),
      completionSignal: opts.config.completionSignal,
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
        // 保守派：宿主统一推送 + 开 PR（凭据不进沙箱）
        await pushBranch(branch, opts.projectDir)
        const pr = await createPullRequest({
          branch,
          title: `fix: issue #${issue.number} ${issue.title}`.slice(0, 100),
          body: `由 Ralph / pi-afk 自动生成\n\n${outcome.summary}\n\nCloses #${issue.number}`,
          projectDir: opts.projectDir,
        })
        events.push({ type: 'pull-request', issue, url: pr.url, prNumber: pr.number })
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

    appendLog(logDir, {
      type: 'issue-result',
      issueNumber: issue.number,
      status: outcome.status,
      summary: outcome.summary,
      commits: result.commits.length,
    })

    return events
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    appendLog(logDir, { type: 'error', issueNumber: issue.number, message })
    return [{ type: 'error', message, issue }]
  }
}

// ---------------------------------------------------------------------------
// 主循环（串行，共识 A1）
// ---------------------------------------------------------------------------

export async function runAfkLoop(opts: LoopOptions): Promise<LoopEvent[]> {
  const events: LoopEvent[] = []
  const skipped = new Set<number>()
  const label = opts.config.label

  for (let i = 1; i <= opts.iterations; i++) {
    events.push({ type: 'iteration-start', iteration: i, total: opts.iterations })
    appendLog(opts.config.logDir, { type: 'iteration-start', iteration: i })

    let issues: Issue[]
    try {
      issues = await listAfkIssues(label)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      events.push({ type: 'error', message })
      break
    }

    const issue = pickIssue(issues, skipped)
    if (!issue) {
      events.push({ type: 'no-more-tasks' })
      appendLog(opts.config.logDir, { type: 'no-more-tasks' })
      break
    }

    events.push({ type: 'issue-picked', issue })
    appendLog(opts.config.logDir, {
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
