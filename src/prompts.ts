import type { Issue } from './issues.js'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** prompts 目录：src/../prompts（dev）== dist/../prompts（build），均指向包根 prompts/ */
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`)
}

function load(name: string): string {
  return readFileSync(join(PROMPTS_DIR, name), 'utf8')
}

const issueVars = (issue: Issue, branch: string) => ({
  ISSUE_NUMBER: String(issue.number),
  ISSUE_TITLE: issue.title,
  ISSUE_BODY: issue.body,
  BRANCH: branch,
})

export function implementerPrompt(issue: Issue, branch: string): string {
  return render(load('implementer.md'), issueVars(issue, branch))
}

/** review agent prompt：审 diff base...HEAD，输出 <verdict> 结构化结论 */
export function reviewerPrompt(issue: Issue, branch: string, baseBranch: string): string {
  return render(load('reviewer.md'), { ...issueVars(issue, branch), BASE_BRANCH: baseBranch })
}

/** 修复轮 implementer prompt：原 issue + review 问题清单 */
export function implementerFixPrompt(issue: Issue, branch: string, feedback: string): string {
  return render(load('fixer.md'), { ...issueVars(issue, branch), REVIEW_FEEDBACK: feedback })
}

/** merger agent prompt：合并 PR（解冲突是核心职责之一），带冲突文件清单 */
export function mergerPrompt(
  issue: Issue,
  branch: string,
  baseBranch: string,
  files: string[],
): string {
  const conflicted =
    files.length > 0
      ? files.map((f) => `- \`${f}\``).join('\n')
      : '（未检测到，以 git status 为准）'
  return render(load('merger.md'), {
    ...issueVars(issue, branch),
    BASE_BRANCH: baseBranch,
    CONFLICTED_FILES: conflicted,
  })
}
