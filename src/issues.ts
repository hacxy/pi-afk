import { execSync } from 'node:child_process'
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
