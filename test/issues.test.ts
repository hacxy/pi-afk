import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { fetchOriginMain } from '../src/issues.js'

/**
 * fetchOriginMain（issue #20）：宿主在沙箱运行前刷新 origin/main，
 * 让 worktree 从最新远端基线创建。用真实 git 仓库验证：
 * 本地 main 落后于 origin 时，fetch 后 origin/main 仍能拿到远端最新。
 */

let dir: string
let origin: string
let work: string

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function revParse(cwd: string, ref: string): string {
  return execFileSync('git', ['rev-parse', ref], { cwd, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'afk-fetch-test-'))
  origin = join(dir, 'origin.git')
  work = join(dir, 'work')
  // 裸远端仓库（HEAD 指向 main）
  git(['init', '--bare', '-q', '-b', 'main', origin], dir)
  // 种子仓库：首个提交推送到 origin/main
  const seed = join(dir, 'seed')
  git(['init', '-q', '-b', 'main', seed], dir)
  git(['config', 'user.name', 'test'], seed)
  git(['config', 'user.email', 'test@test'], seed)
  writeFileSync(join(seed, 'a.txt'), 'a\n')
  git(['add', '.'], seed)
  git(['commit', '-q', '-m', 'a'], seed)
  git(['push', '-q', origin, 'main'], seed)
  // 工作仓库：clone 自 origin（本地 main 与 origin/main 一致）
  git(['clone', '-q', origin, work], dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('fetchOriginMain', () => {
  it('本地 main 落后于 origin 时，fetch 后 origin/main 刷新到远端最新（本地 main 不动）', async () => {
    // 远端推进：advance 仓库在 origin 上新增提交，work 未同步
    const advance = join(dir, 'advance')
    git(['clone', '-q', origin, advance], dir)
    git(['config', 'user.name', 'test'], advance)
    git(['config', 'user.email', 'test@test'], advance)
    writeFileSync(join(advance, 'b.txt'), 'b\n')
    git(['add', '.'], advance)
    git(['commit', '-q', '-m', 'b'], advance)
    git(['push', '-q', 'origin', 'main'], advance)

    // 前置：work 的 origin/main 落后于远端，本地 main 也在旧提交
    const localBefore = revParse(work, 'main')
    const remoteHead = revParse(advance, 'main')
    expect(revParse(work, 'origin/main')).not.toBe(remoteHead)

    await fetchOriginMain(work)

    // fetch 只刷新远程跟踪分支，本地 main 不被改动
    expect(revParse(work, 'origin/main')).toBe(remoteHead)
    expect(revParse(work, 'main')).toBe(localBefore)
  })

  it('origin/main 已最新时 fetch 幂等成功', async () => {
    await expect(fetchOriginMain(work)).resolves.toBeUndefined()
    expect(revParse(work, 'origin/main')).toBe(revParse(work, 'main'))
  })

  it('远端不可达时抛出错误（调用方据此降级本地 HEAD 基线，不阻断流程）', async () => {
    git(['remote', 'set-url', 'origin', join(dir, 'missing.git')], work)
    await expect(fetchOriginMain(work)).rejects.toThrow(/git fetch origin main 失败/)
  })
})
