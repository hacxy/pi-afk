import type { Issue } from './issues.js'

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, dirname, resolve } from 'node:path'
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

/**
 * 解析生效的模板路径（优先级：全局 ~/.afk/prompts/ > 配置 promptFile > 包内默认）
 */
export function resolvePromptFile(opts: { configPromptFile?: string; name?: string }): string {
  const name = opts.name ?? 'ralph.md'
  // 1. 全局覆盖：~/.afk/prompts/
  const globalPath = join(homedir(), '.afk', 'prompts', name)
  if (existsSync(globalPath)) return globalPath
  // 2. 配置指定（绝对或相对路径）
  if (opts.configPromptFile) {
    if (isAbsolute(opts.configPromptFile)) return opts.configPromptFile
    return resolve(process.cwd(), opts.configPromptFile)
  }
  // 3. 包内默认
  return promptFilePath(name)
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
