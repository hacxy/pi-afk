import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { config } from './config.js'
import { slugify } from './utils.js'

function git(args: string, cwd?: string): string {
  return execSync(`git ${args}`, {
    encoding: 'utf8',
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

export function branchName(issue: { number: number; title: string }): string {
  return `${config.branchPrefix}/issue-${issue.number}-${slugify(issue.title)}`
}

export function worktreePath(branch: string): string {
  return resolve(config.worktreesDir, branch)
}

/**
 * 为 issue 建独立 worktree（基线 = 最新 origin/main）。
 * 每个 issue 一个 worktree，planner/implementer/reviewer 三阶段顺序共用（代码累积）。
 */
export function createWorktree(branch: string): string {
  const path = worktreePath(branch)
  mkdirSync(resolve(config.worktreesDir), { recursive: true })
  git('fetch origin main')
  git(`worktree add "${path}" -b "${branch}" origin/main`)
  return path
}

export function removeWorktree(path: string): void {
  try {
    git(`worktree remove "${path}" --force`)
    git('worktree prune')
  } catch {
    // 清理失败不致命
  }
}

export function pushBranch(path: string, branch: string): void {
  git(`push -u origin "${branch}"`, path)
}
