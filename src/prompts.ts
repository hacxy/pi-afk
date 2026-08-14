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
