import { execSync } from 'node:child_process'

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
