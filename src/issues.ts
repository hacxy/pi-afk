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
