import { execFileSync, execSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { config } from './config.js'

export interface Issue {
  number: number
  title: string
  body: string
  labels: string[]
}

function gh(args: string): string {
  return execSync(`gh ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** 拉取待处理 issue：含 agent:todo，且不含 done/failed（label 状态机入口） */
export function listTodoIssues(): Issue[] {
  const raw = gh(
    `issue list --label "${config.todoLabel}" --state open --json number,title,body,labels ` +
      `--jq '.[] | {number: .number, title: .title, body: .body, labels: [.labels[].name]}'`,
  )
  const issues = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Issue)
  return issues.filter(
    (i) => !i.labels.some((l) => l === config.doneLabel || l === config.failedLabel),
  )
}

export function addLabel(number: number, label: string): void {
  gh(`issue edit ${number} --add-label "${label}"`)
}

export function removeLabel(number: number, label: string): void {
  gh(`issue edit ${number} --remove-label "${label}"`)
}

/**
 * 开 PR（D1）：head=afk 分支，base=基线分支，body 带 Closes #N（人工 merge 时 GitHub 自动关 issue）。
 * execFileSync 传参数组，规避 shell 转义；返回 PR URL。
 */
export function openPr(opts: {
  branch: string
  base: string
  title: string
  body: string
}): string {
  const file = join(tmpdir(), `afk-pr-${Date.now()}.md`)
  writeFileSync(file, opts.body)
  try {
    const url = execFileSync(
      'gh',
      [
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
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return url
  } finally {
    unlinkSync(file)
  }
}

/** 当前仓库 owner/repo（compare 链接用） */
export function repoName(): string {
  return gh('repo view --json nameWithOwner --jq .nameWithOwner').trim()
}

/** 在 issue 上留 comment（成功/失败回报）。正文走 --body-file 避免 shell 转义。 */
export function addComment(number: number, body: string): void {
  const file = join(tmpdir(), `afk-comment-${number}-${Date.now()}.md`)
  writeFileSync(file, body)
  try {
    gh(`issue comment ${number} --body-file "${file}"`)
  } finally {
    unlinkSync(file)
  }
}
