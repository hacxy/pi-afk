/**
 * git 边界效应测试：用真实本地临时仓库跑 worktree 归档 / 删分支 / 干净重跑。
 * 每个用例自建 bare remote 作为 origin，验证 createWorktree/archiveWorktree/deleteBranch/cleanupStale。
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  archiveWorktree,
  cleanupStale,
  createWorktree,
  deleteBranch,
  worktreePath,
} from '../src/git.js'

let repo: string
let remote: string
let worktreesDir: string
let failedDir: string

function sh(cmd: string, cwd = repo): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function branchExists(branch: string): boolean {
  const out = sh(`git branch --list "${branch}"`)
  return out.trim().length > 0
}

function worktrees(): string[] {
  return sh('git worktree list --porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => realpathSync(l.slice('worktree '.length)))
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'afk-git-'))
  remote = mkdtempSync(join(tmpdir(), 'afk-git-remote-'))
  worktreesDir = join(repo, '.afk', 'worktrees')
  failedDir = join(repo, '.afk', 'failed')
  sh('git init --bare', remote)
  sh('git init -b main')
  sh('git config user.email test@example.com')
  sh('git config user.name test')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  sh('git add -A')
  sh('git commit -m init')
  sh(`git remote add origin ${remote}`)
  sh('git push -u origin main')
})

afterEach(() => {
  sh('git worktree prune')
  sh(`rm -rf "${repo}"`)
  sh(`rm -rf "${remote}"`, tmpdir())
})

describe('createWorktree（真实仓库）', () => {
  it('从 origin/main 建 worktree + 本地分支', () => {
    const path = createWorktree('afk/issue-1-demo', worktreesDir, repo)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(path, 'README.md'))).toBe(true)
    expect(branchExists('afk/issue-1-demo')).toBe(true)
    expect(worktrees()).toContain(realpathSync(path))
  })
})

describe('deleteBranch（真实仓库）', () => {
  it('删除本地分支；分支不存在也不抛', () => {
    createWorktree('afk/issue-2-demo', worktreesDir, repo)
    const path = worktreePath('afk/issue-2-demo', worktreesDir)
    // 先注销 worktree 再删分支（分支被 worktree 占用时 branch -D 会失败）
    sh(`git worktree remove "${path}" --force`)
    sh('git worktree prune')
    deleteBranch('afk/issue-2-demo', repo)
    expect(branchExists('afk/issue-2-demo')).toBe(false)

    // 幂等：不存在的分支不抛
    expect(() => deleteBranch('afk/issue-never-existed')).not.toThrow()
  })
})

describe('archiveWorktree（真实仓库）', () => {
  it('把 worktree 目录搬到 failed/<branch>，注销注册，保留现场', () => {
    const path = createWorktree('afk/issue-3-demo', worktreesDir, repo)
    writeFileSync(join(path, 'WIP.txt'), 'agent 写的半成品\n')
    const dest = archiveWorktree(path, 'afk/issue-3-demo', failedDir, repo)

    expect(dest).toBe(join(failedDir, 'afk/issue-3-demo'))
    expect(existsSync(join(dest as string, 'WIP.txt'))).toBe(true) // 现场保留
    expect(existsSync(path)).toBe(false) // 原路径已搬走
    expect(worktrees()).not.toContain(path) // 注册已注销

    // 归档后可删分支（不再被 worktree 占用）
    deleteBranch('afk/issue-3-demo', repo)
    expect(branchExists('afk/issue-3-demo')).toBe(false)
  })

  it('路径不存在时返回 undefined 不抛', () => {
    expect(archiveWorktree('/nonexistent/path', 'afk/issue-x', failedDir, repo)).toBeUndefined()
  })
})

describe('cleanupStale + 干净重跑（真实仓库）', () => {
  it('残留 worktree + 分支时，再次 createWorktree 能清理干净并成功重跑', () => {
    // 第一次跑：建 worktree + 分支（模拟上次跑完后残留——未删分支/worktree）
    const first = createWorktree('afk/issue-4-demo', worktreesDir, repo)
    writeFileSync(join(first, 'attempt1.txt'), '1')
    expect(branchExists('afk/issue-4-demo')).toBe(true)

    // 直接 cleanupStale 应清掉 worktree + 分支
    cleanupStale('afk/issue-4-demo', worktreesDir, repo)
    expect(existsSync(first)).toBe(false)
    expect(branchExists('afk/issue-4-demo')).toBe(false)

    // 重跑：createWorktree 内部先 cleanupStale，不被残留卡住
    const second = createWorktree('afk/issue-4-demo', worktreesDir, repo)
    expect(existsSync(second)).toBe(true)
    expect(branchExists('afk/issue-4-demo')).toBe(true)
    expect(existsSync(join(second, 'attempt1.txt'))).toBe(false) // 从 origin/main 全新重建
  })
})
