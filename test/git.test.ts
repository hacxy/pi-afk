/**
 * git 边界效应测试：用真实本地临时仓库跑 worktree 归档 / 删分支 / 干净重跑。
 * 每个用例自建 bare remote 作为 origin，验证 createWorktree/archiveWorktree/deleteBranch/cleanupStale。
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../src/config.js'
import {
  archiveWorktree,
  cleanupStale,
  conflictedFiles,
  createWorktree,
  deleteBranch,
  fetchBase,
  hasRemoteBranch,
  mergeBaseIntoBranch,
  pushBranch,
  worktreePath,
} from '../src/git.js'

/** 测试配置：内置默认（branchPrefix/worktreesDir 等与仓库内路径一致） */
const cfg = { ...DEFAULT_CONFIG }

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

describe('fetchBase（真实仓库）', () => {
  it('返回 origin/main 当前 sha；远端推进后拿到新 sha', async () => {
    const sha1 = await fetchBase(cfg, repo)
    expect(sha1).toMatch(/^[0-9a-f]{40}$/)

    // 远端推进后重新 fetch，应拿到新 sha
    writeFileSync(join(repo, 'README.md'), 'v2\n')
    sh('git add -A')
    sh('git commit -m v2')
    sh('git push -u origin main')
    const sha2 = await fetchBase(cfg, repo)
    expect(sha2).not.toBe(sha1)
  })
})

describe('createWorktree（真实仓库）', () => {
  it('从 fetchBase 拿到的基线 sha 建 worktree + 本地分支', async () => {
    const base = await fetchBase(cfg, repo)
    const path = await createWorktree(cfg, 'afk/issue-1-demo', base, worktreesDir, repo)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(path, 'README.md'))).toBe(true)
    expect(branchExists('afk/issue-1-demo')).toBe(true)
    expect(worktrees()).toContain(realpathSync(path))
  })
})

describe('deleteBranch（真实仓库）', () => {
  it('删除本地分支；分支不存在也不抛', async () => {
    const base = await fetchBase(cfg, repo)
    await createWorktree(cfg, 'afk/issue-2-demo', base, worktreesDir, repo)
    const path = worktreePath(cfg, 'afk/issue-2-demo', worktreesDir)
    // 先注销 worktree 再删分支（分支被 worktree 占用时 branch -D 会失败）
    sh(`git worktree remove "${path}" --force`)
    sh('git worktree prune')
    await deleteBranch('afk/issue-2-demo', repo)
    expect(branchExists('afk/issue-2-demo')).toBe(false)

    // 幂等：不存在的分支不抛
    await expect(deleteBranch('afk/issue-never-existed', repo)).resolves.toBeUndefined()
  })
})

describe('archiveWorktree（真实仓库）', () => {
  it('把 worktree 目录搬到 failed/<branch>，注销注册，保留现场', async () => {
    const base = await fetchBase(cfg, repo)
    const path = await createWorktree(cfg, 'afk/issue-3-demo', base, worktreesDir, repo)
    writeFileSync(join(path, 'WIP.txt'), 'agent 写的半成品\n')
    const dest = await archiveWorktree(cfg, path, 'afk/issue-3-demo', failedDir, repo)

    expect(dest).toBe(join(failedDir, 'afk/issue-3-demo'))
    expect(existsSync(join(dest as string, 'WIP.txt'))).toBe(true) // 现场保留
    expect(existsSync(path)).toBe(false) // 原路径已搬走
    expect(worktrees()).not.toContain(path) // 注册已注销

    // 归档后可删分支（不再被 worktree 占用）
    await deleteBranch('afk/issue-3-demo', repo)
    expect(branchExists('afk/issue-3-demo')).toBe(false)
  })

  it('路径不存在时返回 undefined 不抛', async () => {
    await expect(
      archiveWorktree(cfg, '/nonexistent/path', 'afk/issue-x', failedDir, repo),
    ).resolves.toBeUndefined()
  })
})

describe('cleanupStale + 干净重跑（真实仓库）', () => {
  it('残留 worktree + 分支时，再次 createWorktree 能清理干净并成功重跑', async () => {
    const base = await fetchBase(cfg, repo)
    // 第一次跑：建 worktree + 分支（模拟上次跑完后残留——未删分支/worktree）
    const first = await createWorktree(cfg, 'afk/issue-4-demo', base, worktreesDir, repo)
    writeFileSync(join(first, 'attempt1.txt'), '1')
    expect(branchExists('afk/issue-4-demo')).toBe(true)

    // 直接 cleanupStale 应清掉 worktree + 分支
    await cleanupStale(cfg, 'afk/issue-4-demo', worktreesDir, repo)
    expect(existsSync(first)).toBe(false)
    expect(branchExists('afk/issue-4-demo')).toBe(false)

    // 重跑：createWorktree 内部先 cleanupStale，不被残留卡住
    const second = await createWorktree(cfg, 'afk/issue-4-demo', base, worktreesDir, repo)
    expect(existsSync(second)).toBe(true)
    expect(branchExists('afk/issue-4-demo')).toBe(true)
    expect(existsSync(join(second, 'attempt1.txt'))).toBe(false) // 从 origin/main 全新重建
  })
})

describe('hasRemoteBranch + force push（真实仓库）', () => {
  it('远端分支存在判定 + force-with-lease 覆盖非快进 push', async () => {
    const base = await fetchBase(cfg, repo)
    const path = await createWorktree(cfg, 'afk/issue-f', base, worktreesDir, repo)

    // 未 push 前：远端无分支
    expect(await hasRemoteBranch('afk/issue-f', repo)).toBe(false)

    // 首次普通 push → 远端有分支
    writeFileSync(join(path, 'f.txt'), '1\n')
    sh('git add -A && git commit -m one', path)
    await pushBranch(path, 'afk/issue-f')
    expect(await hasRemoteBranch('afk/issue-f', repo)).toBe(true)

    // 重写历史（amend）→ 普通 push 非快进失败 → force-with-lease 成功
    writeFileSync(join(path, 'f.txt'), '2\n')
    sh('git add -A && git commit --amend -m two --no-edit', path)
    await expect(pushBranch(path, 'afk/issue-f')).rejects.toThrow()
    await pushBranch(path, 'afk/issue-f', { force: true })
  })
})

describe('mergeBaseIntoBranch + conflictedFiles（真实仓库）', () => {
  it('分支落后 base：干净合并 → true，分支获得 base 新内容', async () => {
    const base = await fetchBase(cfg, repo)
    const path = await createWorktree(cfg, 'afk/issue-m', base, worktreesDir, repo)
    // 分支改动（不碰 README）
    writeFileSync(join(path, 'feat.txt'), 'issue work\n')
    sh('git add -A && git commit -m feat', path)

    // base 推进（改 README，与分支无冲突）
    writeFileSync(join(repo, 'README.md'), 'base v2\n')
    sh('git add -A && git commit -m base-v2')
    sh('git push -u origin main')
    await fetchBase(cfg, repo)

    expect(await mergeBaseIntoBranch(path, 'afk/issue-m', 'main')).toBe(true)
    expect(conflictedFiles(path)).resolves.toEqual([])
    // 分支现在包含 base 新内容 + 自己的改动
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toContain('base v2')
    expect(existsSync(join(path, 'feat.txt'))).toBe(true)
  })

  it('与 base 同文件冲突：merge → false，conflictedFiles 列出文件；化解后清单清空', async () => {
    const base = await fetchBase(cfg, repo)
    const path = await createWorktree(cfg, 'afk/issue-c', base, worktreesDir, repo)
    // 分支改 README 第一行
    writeFileSync(join(path, 'README.md'), 'branch line\n')
    sh('git add -A && git commit -m feat', path)

    // base 也改 README 第一行（同一行 → 冲突）
    writeFileSync(join(repo, 'README.md'), 'base line\n')
    sh('git add -A && git commit -m base-v2')
    sh('git push -u origin main')
    await fetchBase(cfg, repo)

    expect(await mergeBaseIntoBranch(path, 'afk/issue-c', 'main')).toBe(false)
    const files = await conflictedFiles(path)
    expect(files).toEqual(['README.md'])

    // 化解（模拟 merger agent）：保留双方意图 → git add + 完成 merge
    writeFileSync(join(path, 'README.md'), 'base line + branch line\n')
    sh('git add README.md', path)
    sh('git commit --no-edit', path)
    expect(await conflictedFiles(path)).toEqual([])
    expect(existsSync(join(path, 'README.md'))).toBe(true)
  })
})
