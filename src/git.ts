import { execa } from 'execa'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { config } from './config.js'

/** 跑 git 命令：参数数组传递（无 shell 转义风险），非零退出/spawn 失败 reject。 */
async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execa('git', args, { cwd })
  return stdout
}

/** 分支名规范：只使用 issue 编号（afk/issue-N），避免非 ASCII 触发 GitHub 隐藏字符告警 */
export function branchName(issue: { number: number }): string {
  return `${config.branchPrefix}/issue-${issue.number}`
}

export function worktreePath(branch: string, dir: string = config.worktreesDir): string {
  return resolve(dir, branch)
}

/** 删本地分支（幂等：分支不存在不抛）。repoRoot = 目标仓库根（默认 cwd）。 */
export async function deleteBranch(
  branch: string,
  repoRoot: string = process.cwd(),
): Promise<void> {
  try {
    await git(['branch', '-D', branch], repoRoot)
  } catch {
    // 分支可能不存在（git 阶段失败时）
  }
}

/**
 * 清理同名残留（worktree + 本地分支）。
 * 保证「改回 agent:todo 重跑」不被残留分支/worktree 卡住（含上次崩溃的残留）。
 */
export async function cleanupStale(
  branch: string,
  dir: string = config.worktreesDir,
  repoRoot: string = process.cwd(),
): Promise<void> {
  const path = worktreePath(branch, dir)
  try {
    await git(['worktree', 'remove', path, '--force'], repoRoot)
  } catch {
    // 残留 worktree 可能不存在
  }
  await git(['worktree', 'prune'], repoRoot)
  await deleteBranch(branch, repoRoot)
}

/**
 * 为 issue 建独立 worktree（基线 = 最新 origin/<base>）。
 * 每个 issue 一个 worktree，planner/implementer/reviewer 三阶段顺序共用（代码累积）。
 * 建之前先 cleanupStale，保证残留分支/worktree 不会卡住重跑。
 */
export async function createWorktree(
  branch: string,
  dir: string = config.worktreesDir,
  repoRoot: string = process.cwd(),
): Promise<string> {
  const path = worktreePath(branch, dir)
  mkdirSync(resolve(dir), { recursive: true })
  await cleanupStale(branch, dir, repoRoot)
  await git(['fetch', 'origin', config.baseBranch], repoRoot)
  await git(['worktree', 'add', path, '-b', branch, `origin/${config.baseBranch}`], repoRoot)
  return path
}

export async function removeWorktree(
  path: string,
  repoRoot: string = process.cwd(),
): Promise<void> {
  try {
    await git(['worktree', 'remove', path, '--force'], repoRoot)
    await git(['worktree', 'prune'], repoRoot)
  } catch {
    // 清理失败不致命
  }
}

/**
 * 失败现场归档：把 worktree 目录搬到 <failedDir>/<branch>/（保留代码现场供排查），
 * 并 prune 掉失效的 worktree 注册。返回归档路径；worktree 目录不存在时返回 undefined。
 */
export async function archiveWorktree(
  path: string,
  branch: string,
  failedDir: string = config.failedDir,
  repoRoot: string = process.cwd(),
): Promise<string | undefined> {
  if (!existsSync(path)) return undefined
  const dest = resolve(failedDir, branch)
  mkdirSync(dirname(dest), { recursive: true })
  // 同名重跑的旧归档先清掉，避免 rename 目标已存在报错
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  renameSync(path, dest)
  await git(['worktree', 'prune'], repoRoot)
  return dest
}

export async function pushBranch(path: string, branch: string): Promise<void> {
  await git(['push', '-u', 'origin', branch], path)
}
