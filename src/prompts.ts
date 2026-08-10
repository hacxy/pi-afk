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

/** 包内默认 resolve 模板（T13 冲突自动化解：预同步冲突时派发的第二次沙箱 run） */
export function resolvePromptFilePath(): string {
  return join(promptsDir(), 'resolve.md')
}

/** 项目自定义模板路径（sandcastle 官方标准：.sandcastle/prompt.md） */
export function projectPromptPath(projectDir: string): string {
  return join(projectDir, '.sandcastle', 'prompt.md')
}

/** 项目自定义 resolve 模板路径（T13：.sandcastle/resolve.md） */
export function projectResolvePromptPath(projectDir: string): string {
  return join(projectDir, '.sandcastle', 'resolve.md')
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
 * 解析生效的 resolve 模板路径（T13）：
 * 项目 .sandcastle/resolve.md > 包内默认 prompts/resolve.md
 */
export function resolveResolvePromptFile(projectDir: string): string {
  const projectResolve = projectResolvePromptPath(projectDir)
  return existsSync(projectResolve) ? projectResolve : resolvePromptFilePath()
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
 * afk init：幂等复制默认 resolve 模板到项目 .sandcastle/resolve.md（已存在则跳过，不覆盖用户修改）。
 * 返回项目 resolve 模板路径。
 */
export function ensureProjectResolvePrompt(projectDir: string): string {
  const target = projectResolvePromptPath(projectDir)
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(resolvePromptFilePath(), target)
  }
  return target
}

/**
 * .gitignore 规则：sandcastle 官方约定只忽略运行时产物（.env / logs/ / worktrees/），
 * 模板文件 .sandcastle/prompt.md 不在忽略范围，可提交 git 团队共享。
 * （sandcastle init 生成的 .sandcastle/.gitignore 内容即 .env / logs/ / worktrees/，
 *  平移到项目根 .gitignore 即带 .sandcastle/ 前缀的这三条）
 */
const SANDBOX_GITIGNORE_ENTRIES = [
  '# pi-afk: sandcastle 运行时产物（.sandcastle/prompt.md 模板可提交）',
  '.sandcastle/.env',
  '.sandcastle/logs/',
  '.sandcastle/worktrees/',
  '',
].join('\n')

/** 旧版 pi-afk 管理的忽略规则（整目录或近似方案，需迁移为官方三条） */
const LEGACY_PI_AFK_GITIGNORE_PATTERNS = [
  /^\s*\.sandcastle\/\s*$/gm, // 最初版：整目录忽略
  /^\s*\.sandcastle\/\*\s*$/gm, // #8 版：忽略全部
  /^\s*!\s*\.sandcastle\/prompt\.md\s*$/gm, // #8 版：放行 prompt.md
  /^\s*#\s*pi-afk\s*运行时工作区.*$/gm, // #8 版注释
]

/**
 * 确保项目 .gitignore 按 sandcastle 官方标准忽略运行时产物（幂等）。
 * 旧版规则（`.sandcastle/` 整目录、`.sandcastle/*` + `!.sandcastle/prompt.md`）自动迁移。
 */
export function ensureSandcastleGitignore(projectDir: string): void {
  const gitignore = join(projectDir, '.gitignore')
  let content = ''
  if (existsSync(gitignore)) {
    content = readFileSync(gitignore, 'utf8')
    // 幂等：已有官方三条（worktrees/ 最具代表性）则视为已就绪
    if (content.includes('.sandcastle/worktrees/')) return
    // 迁移旧版 pi-afk 规则
    for (const re of LEGACY_PI_AFK_GITIGNORE_PATTERNS) {
      content = content.replace(re, '')
    }
  }
  const trimmed = content.replace(/[\s\uFEFF]*$/, '')
  writeFileSync(
    gitignore,
    trimmed ? `${trimmed}\n${SANDBOX_GITIGNORE_ENTRIES}` : SANDBOX_GITIGNORE_ENTRIES,
    'utf8',
  )
}

/** issue 评论文本（供 prompt 注入） */
function issueCommentsText(issue: Pick<Issue, 'comments'>): string {
  return issue.comments.length > 0
    ? issue.comments.map((c) => `- **${c.author.login}**: ${c.body}`).join('\n\n')
    : '（无评论）'
}

/** 组装单 issue 的 promptArgs（供 sandcastle 替换 {{KEY}}） */
export function buildIssuePromptArgs(opts: {
  issue: Issue
  branch: string
  recentCommits: string
}): Record<string, string> {
  const { issue, branch, recentCommits } = opts
  return {
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || '（无正文）',
    ISSUE_COMMENTS: issueCommentsText(issue),
    RECENT_COMMITS: recentCommits,
    BRANCH: branch,
  }
}

/**
 * 组装 resolve run 的 promptArgs（T13）：冲突文件清单 + 被合并的 main 提交 SHA +
 * 原始 issue 上下文（编号/标题/正文/评论）+ 分支名。
 */
export function buildResolvePromptArgs(opts: {
  issue: Issue
  branch: string
  conflictFiles: string[]
  mergeSha: string
}): Record<string, string> {
  const { issue, branch, conflictFiles, mergeSha } = opts
  const fileList =
    conflictFiles.length > 0
      ? conflictFiles.map((f) => `- \`${f}\``).join('\n')
      : '- （无法获取冲突文件清单，请查看 git status）'
  return {
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || '（无正文）',
    ISSUE_COMMENTS: issueCommentsText(issue),
    CONFLICT_FILES: fileList,
    CONFLICT_COUNT: String(conflictFiles.length),
    MERGED_SHA: mergeSha,
    BRANCH: branch,
  }
}
