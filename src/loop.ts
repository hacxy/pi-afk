import { join } from 'node:path'

import { LOG_DIR, type GlobalConfig } from './config.js'
import {
  listAfkIssues,
  commentOnIssue,
  publishAndMerge,
  recentRalphCommits,
  fetchOriginMain,
  isHitlIssue,
  VerifyFailedError,
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
  | { type: 'presync-conflict'; issue: Issue; files: string[] }
  | { type: 'verify-failed'; issue: Issue; reason: string }
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
// 导出供测试走真实发布路径（验证门接线）
// ---------------------------------------------------------------------------

export async function processIssue(issue: Issue, opts: LoopOptions): Promise<LoopEvent[]> {
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
        // 预同步（issue #23）：push 前宿主把最新 origin/main 合并进分支（干净 → 正常发布；
        // 冲突 → 分支照常推送 + PR 留言冲突清单，不 autoMerge、不抛错）。
        // 验证门（issue #22）：配置了 verifyCommand 时，预同步后、push 前在分支临时 worktree
        // 执行验证，非零退出抛 VerifyFailedError，由下方 catch 留言说明并停止本轮（不发版）
        const { pr, merged, presyncConflict } = await publishAndMerge({
          branch,
          title: `fix: issue #${issue.number} ${issue.title}`.slice(0, 100),
          body: `由 Ralph / pi-afk 自动生成\n\n${outcome.summary}\n\nCloses #${issue.number}`,
          projectDir: opts.projectDir,
          autoMerge: opts.config.autoMerge,
          verifyCommand: opts.config.verifyCommand,
        })
        events.push({ type: 'pull-request', issue, url: pr.url, prNumber: pr.number })

        // 预同步冲突：PR 已建 + 已留言冲突清单，待人工处理（该 issue 本轮跳过）
        if (presyncConflict) {
          events.push({ type: 'presync-conflict', issue, files: presyncConflict.files })
          appendLog(LOG_DIR, {
            type: 'presync-conflict',
            issueNumber: issue.number,
            files: presyncConflict.files,
          })
        }

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
    if (err instanceof VerifyFailedError) {
      // 验证门失败：不 push、留言说明验证失败、该 issue 本轮停止（不发版）
      const reason = err.message
      await commentOnIssue(
        issue.number,
        `Ralph 验证未通过，未发布（未创建 PR）。验证命令输出：\n\n${reason}`,
      )
      appendLog(LOG_DIR, { type: 'verify-failed', issueNumber: issue.number, message: reason })
      return [...events, { type: 'verify-failed', issue, reason }]
    }
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

    // blocked/skipped 的 issue 本轮不再尝试；验证失败（verify-failed）同样本轮停止
    const terminal = issueEvents.find(
      (e): e is Extract<LoopEvent, { type: 'issue-outcome' }> => e.type === 'issue-outcome',
    )
    const verifyFailed = issueEvents.some((e) => e.type === 'verify-failed')
    // 预同步冲突：PR 已建 + 已留言，待人工处理——本轮不再重复派发（不阻塞循环处理下一个 issue）
    const presyncConflict = issueEvents.some((e) => e.type === 'presync-conflict')
    if (verifyFailed || presyncConflict || (terminal && terminal.status !== 'done')) {
      skipped.add(issue.number)
    }
  }

  return events
}
