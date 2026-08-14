import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

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

export function worktreePath(branch: string, dir: string = config.worktreesDir): string {
  return resolve(dir, branch)
}

/** 删本地分支（幂等：分支不存在不抛）。repoRoot = 目标仓库根（默认 cwd）。 */
export function deleteBranch(branch: string, repoRoot: string = process.cwd()): void {
  try {
    git(`branch -D "${branch}"`, repoRoot)
  } catch {
    // 分支可能不存在（git 阶段失败时）
  }
}

/**
 * 清理同名残留（worktree + 本地分支）。
 * 保证「改回 agent:todo 重跑」不被残留分支/worktree 卡住（含上次崩溃的残留）。
 */
export function cleanupStale(
  branch: string,
  dir: string = config.worktreesDir,
  repoRoot: string = process.cwd(),
): void {
  const path = worktreePath(branch, dir)
  try {
    git(`worktree remove "${path}" --force`, repoRoot)
  } catch {
    // 残留 worktree 可能不存在
  }
  git('worktree prune', repoRoot)
  deleteBranch(branch, repoRoot)
}

/**
 * 为 issue 建独立 worktree（基线 = 最新 origin/<base>）。
 * 每个 issue 一个 worktree，planner/implementer/reviewer 三阶段顺序共用（代码累积）。
 * 建之前先 cleanupStale，保证残留分支/worktree 不会卡住重跑。
 */
export function createWorktree(
  branch: string,
  dir: string = config.worktreesDir,
  repoRoot: string = process.cwd(),
): string {
  const path = worktreePath(branch, dir)
  mkdirSync(resolve(dir), { recursive: true })
  cleanupStale(branch, dir, repoRoot)
  git(`fetch origin ${config.baseBranch}`, repoRoot)
  git(`worktree add "${path}" -b "${branch}" origin/${config.baseBranch}`, repoRoot)
  return path
}

export function removeWorktree(path: string, repoRoot: string = process.cwd()): void {
  try {
    git(`worktree remove "${path}" --force`, repoRoot)
    git('worktree prune', repoRoot)
  } catch {
    // 清理失败不致命
  }
}

/**
 * 失败现场归档：把 worktree 目录搬到 <failedDir>/<branch>/（保留代码现场供排查），
 * 并 prune 掉失效的 worktree 注册。返回归档路径；worktree 目录不存在时返回 undefined。
 */
export function archiveWorktree(
  path: string,
  branch: string,
  failedDir: string = config.failedDir,
  repoRoot: string = process.cwd(),
): string | undefined {
  if (!existsSync(path)) return undefined
  const dest = resolve(failedDir, branch)
  mkdirSync(dirname(dest), { recursive: true })
  // 同名重跑的旧归档先清掉，避免 rename 目标已存在报错
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  renameSync(path, dest)
  git('worktree prune', repoRoot)
  return dest
}

export function pushBranch(path: string, branch: string): void {
  git(`push -u origin "${branch}"`, path)
}
