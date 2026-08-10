import type { Issue } from './issues.js'

import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 定位 prompt 模板目录。
 * 开发时: <repo>/prompts/
 * npm 安装后: <pkg>/prompts/（files 已包含）
 */
function promptsDir(): string {
  // tsup 打包后本文件在 <pkg>/dist/，模板在 <pkg>/prompts/
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', 'prompts')
}

export function promptFilePath(name = 'ralph.md'): string {
  return join(promptsDir(), name)
}

export function loadPrompt(name = 'ralph.md'): string {
  return readFileSync(promptFilePath(name), 'utf8')
}

/** 组装单 issue 的 promptArgs（供 sandcastle 替换 {{KEY}}） */
export function buildIssuePromptArgs(opts: {
  issue: Issue
  branch: string
  recentCommits: string
}): Record<string, string> {
  const { issue, branch, recentCommits } = opts
  const comments =
    issue.comments.length > 0
      ? issue.comments.map((c) => `- **${c.author.login}**: ${c.body}`).join('\n\n')
      : '（无评论）'
  return {
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || '（无正文）',
    ISSUE_COMMENTS: comments,
    RECENT_COMMITS: recentCommits,
    BRANCH: branch,
  }
}
