import type { Issue } from './issues.js'

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
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

/** 包内默认模板（sandcastle 官方 simple-loop 命名） */
export function promptFilePath(): string {
  return join(promptsDir(), 'prompt.md')
}

/** 项目自定义模板路径（sandcastle 官方标准：.sandcastle/prompt.md） */
export function projectPromptPath(projectDir: string): string {
  return join(projectDir, '.sandcastle', 'prompt.md')
}

/**
 * 解析生效的模板路径（sandcastle 官方标准）：
 * 项目 .sandcastle/prompt.md > 包内默认 prompts/prompt.md
 */
export function resolvePromptFile(projectDir: string): string {
  const projectPrompt = projectPromptPath(projectDir)
  return existsSync(projectPrompt) ? projectPrompt : promptFilePath()
}

/**
 * afk init：幂等复制默认模板到项目 .sandcastle/prompt.md（已存在则跳过，不覆盖用户修改）。
 * 返回项目模板路径。
 */
export function ensureProjectPrompt(projectDir: string): string {
  const target = projectPromptPath(projectDir)
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(promptFilePath(), target)
  }
  return target
}

/**
 * .gitignore 规则：忽略 sandcastle 运行时产物（worktrees/logs/patches/.env），
 * 但保留 .sandcastle/prompt.md 可提交（团队共享模板）。
 */
const SANDBOX_GITIGNORE_BLOCK = [
  '# pi-afk 运行时工作区（.sandcastle/prompt.md 除外，可提交共享）',
  '.sandcastle/*',
  '!.sandcastle/prompt.md',
  '',
].join('\n')

/**
 * 确保项目 .gitignore 忽略 sandcastle 运行时产物但保留 prompt.md（幂等）。
 * 旧版整目录忽略（`.sandcastle/`）会自动升级，否则 prompt.md 永远无法提交。
 */
export function ensureSandcastleGitignore(projectDir: string): void {
  const gitignore = join(projectDir, '.gitignore')
  let content = ''
  if (existsSync(gitignore)) {
    content = readFileSync(gitignore, 'utf8')
    // 已就绪：已有保留 prompt.md 的规则
    if (content.includes('!.sandcastle/prompt.md')) return
    // 升级旧版整目录忽略行（`.sandcastle/`）
    content = content.replace(/^\s*\.sandcastle\/\s*$/gm, '')
  }
  const trimmed = content.replace(/[\s\uFEFF]*$/, '')
  writeFileSync(
    gitignore,
    trimmed ? `${trimmed}\n${SANDBOX_GITIGNORE_BLOCK}` : SANDBOX_GITIGNORE_BLOCK,
    'utf8',
  )
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
