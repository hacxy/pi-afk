import type { Config } from './config.js'

import { execa } from 'execa'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Issue {
  number: number
  title: string
  body: string
  labels: string[]
}

/** 跑 gh 命令：参数数组传递（无 shell 转义风险），非零退出/spawn 失败 reject。 */
async function gh(args: string[]): Promise<string> {
  const { stdout } = await execa('gh', args)
  return stdout
}

/** 拉取待处理 issue：含 todo label，且不含 done/failed（label 状态机入口） */
export async function listTodoIssues(config: Config): Promise<Issue[]> {
  const raw = await gh([
    'issue',
    'list',
    '--label',
    config.todoLabel,
    '--state',
    'open',
    '--json',
    'number,title,body,labels',
    '--jq',
    '.[] | {number: .number, title: .title, body: .body, labels: [.labels[].name]}',
  ])
  const issues = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Issue)
  return issues.filter(
    (i) => !i.labels.some((l) => l === config.doneLabel || l === config.failedLabel),
  )
}

export async function addLabel(number: number, label: string): Promise<void> {
  await gh(['issue', 'edit', String(number), '--add-label', label])
}

export async function removeLabel(number: number, label: string): Promise<void> {
  await gh(['issue', 'edit', String(number), '--remove-label', label])
}

/**
 * 开 PR（D1）：head=afk 分支，base=基线分支，body 带 Closes #N（人工 merge 时 GitHub 自动关 issue）。
 * body 走 --body-file 避免 shell 转义；返回 PR URL。
 */
export async function openPr(opts: {
  branch: string
  base: string
  title: string
  body: string
}): Promise<string> {
  const file = join(tmpdir(), `afk-pr-${Date.now()}.md`)
  writeFileSync(file, opts.body)
  try {
    const url = await gh([
      'pr',
      'create',
      '--head',
      opts.branch,
      '--base',
      opts.base,
      '--title',
      opts.title,
      '--body-file',
      file,
    ])
    return url.trim()
  } finally {
    unlinkSync(file)
  }
}

/** 当前仓库 owner/repo（compare 链接用） */
export async function repoName(): Promise<string> {
  const out = await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  return out.trim()
}

/** 在 issue 上留 comment（成功/失败回报）。正文走 --body-file 避免 shell 转义。 */
export async function addComment(number: number, body: string): Promise<void> {
  const file = join(tmpdir(), `afk-comment-${number}-${Date.now()}.md`)
  writeFileSync(file, body)
  try {
    await gh(['issue', 'comment', String(number), '--body-file', file])
  } finally {
    unlinkSync(file)
  }
}

/** 在 PR 上留 comment（review 报告 / 修复要求）。正文走 --body-file 避免 shell 转义。 */
export async function prComment(number: number, body: string): Promise<void> {
  const file = join(tmpdir(), `afk-pr-comment-${number}-${Date.now()}.md`)
  writeFileSync(file, body)
  try {
    await gh(['pr', 'comment', String(number), '--body-file', file])
  } finally {
    unlinkSync(file)
  }
}

/** PR mergeable 状态：GitHub 侧合并性判定 */
export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

/** 查 PR mergeable 状态（gh pr view --json mergeable） */
export async function prMergeable(number: number): Promise<Mergeable> {
  const out = await gh(['pr', 'view', String(number), '--json', 'mergeable', '--jq', '.mergeable'])
  const v = out.trim()
  return v === 'MERGEABLE' || v === 'CONFLICTING' ? v : 'UNKNOWN'
}

/** statusCheckRollup 单条目（透传字段按需取） */
export interface CheckRollup {
  status?: string
  conclusion?: string | null
  __typename?: string
  name?: string
}

/** 分析 statusCheckRollup → 整体 checks 状态：终态成功 / 明确失败 / 进行中 / 无 CI */
export function analyzeChecks(rollup: CheckRollup[]): 'pass' | 'fail' | 'pending' | 'none' {
  if (rollup.length === 0) return 'none'
  const failed = ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
  let sawPending = false
  for (const item of rollup) {
    const conclusion = item.conclusion ?? null
    if (conclusion && failed.includes(conclusion)) return 'fail'
    if (item.status !== 'COMPLETED' || !conclusion || conclusion === 'PENDING') {
      sawPending = true
    }
  }
  return sawPending ? 'pending' : 'pass'
}

/** 单次查询 PR checks 状态 */
export async function checksState(number: number): Promise<'pass' | 'fail' | 'pending' | 'none'> {
  const out = await gh([
    'pr',
    'view',
    String(number),
    '--json',
    'statusCheckRollup',
    '--jq',
    '.statusCheckRollup',
  ])
  const raw = out.trim()
  if (!raw) return 'none'
  try {
    return analyzeChecks(JSON.parse(raw) as CheckRollup[])
  } catch {
    return 'pending' // 解析失败按进行中处理，由超时兜底
  }
}

/**
 * 轮询等 checks 到终态：'pass' 通过 / 'fail' 明确失败 / 'timeout' 超时未定。
 * 无 CI（'none'）视为通过（无需等待）。轮询间隔 15s，供测试 mock。
 */
export async function waitForChecksPass(
  number: number,
  timeoutSec: number,
  pollIntervalMs: number = 15_000,
): Promise<'pass' | 'fail' | 'timeout'> {
  const deadline = Date.now() + timeoutSec * 1000
  for (;;) {
    const state = await checksState(number)
    if (state === 'pass' || state === 'none') return 'pass'
    if (state === 'fail') return 'fail'
    if (Date.now() >= deadline) return 'timeout'
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
}

/**
 * 合并 PR（D5）：squash + 删远端分支。
 * 非零退出（冲突 / checks 未过 / 分支保护）reject，由调用方决定重试或失败。
 */
export async function mergePr(number: number): Promise<void> {
  await gh(['pr', 'merge', String(number), '--squash', '--delete-branch'])
}
