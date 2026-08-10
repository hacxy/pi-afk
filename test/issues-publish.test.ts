import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { publishAndMerge, VerifyFailedError } from '../src/issues.js'

/**
 * 发布流水线（T8，issue #21）：push → create PR →（可选）squash 合并 + 30s 重试。
 * 测试透过公开 API 走真实代码路径，仅在进程边界（execFile）处打桩脚本化 gh/git 输出。
 */

vi.mock('node:child_process', () => {
  const execFile = vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      cb(new Error('未脚本化的 execFile 调用'))
    },
  )
  return { execFile }
})

const execFileMock = vi.mocked(execFile)

type ScriptResult = { stdout?: string; stderr?: string } | { error: Error }

function scriptExec(script: (file: string, args: string[]) => ScriptResult): void {
  execFileMock.mockImplementation((file, args, _opts, cb) => {
    const result = script(file, args)
    if ('error' in result) {
      cb(result.error)
    } else {
      cb(null, { stdout: result.stdout ?? '', stderr: result.stderr ?? '' })
    }
  })
}

/** 模拟 gh 失败：stderr 即 gh 原始输出（issues.ts 的 gh 包装会原样拼进错误信息） */
function ghError(stderr: string): Error & { stderr: string } {
  return Object.assign(new Error(`gh command failed: ${stderr}`), { stderr })
}

/** 正常路径脚本：push 成功 → PR 创建返回 42 号 → merge 成功 */
const happyPath: (file: string, args: string[]) => ScriptResult = (file, args) => {
  if (file === 'git' && args[0] === 'push') return { stdout: 'ok' }
  if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
    return { stdout: 'https://github.com/hacxy/pi-afk/pull/42' }
  }
  if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') return { stdout: 'merged' }
  if (file === 'git' && args[0] === 'worktree') return { stdout: '' }
  return { error: new Error(`unexpected call: ${file} ${args.join(' ')}`) }
}

const baseOpts = {
  branch: 'agent/issue-21',
  title: 'fix: issue #21 test',
  body: 'Closes #21',
  projectDir: '/tmp/project',
}

describe('publishAndMerge', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    scriptExec(happyPath)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('autoMerge 关闭：只推送 + 建 PR，不触发合并', async () => {
    const result = await publishAndMerge({ ...baseOpts, autoMerge: false })

    expect(result.merged).toBe(false)
    expect(result.pr.number).toBe(42)
    expect(result.pr.url).toBe('https://github.com/hacxy/pi-afk/pull/42')
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    expect(calls).toEqual([
      ['git', 'push -u origin agent/issue-21'],
      [
        'gh',
        'pr create --base main --head agent/issue-21 --title fix: issue #21 test --body Closes #21',
      ],
    ])
  })

  it('autoMerge 开启：push → 建 PR → squash 合并全流程跑通', async () => {
    const result = await publishAndMerge({ ...baseOpts, autoMerge: true })

    expect(result.merged).toBe(true)
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    expect(calls).toEqual([
      ['git', 'push -u origin agent/issue-21'],
      [
        'gh',
        'pr create --base main --head agent/issue-21 --title fix: issue #21 test --body Closes #21',
      ],
      ['gh', 'pr merge 42 --squash --delete-branch'],
    ])
  })

  it('合并失败等 30 秒重试一次，重试成功即完成合并', async () => {
    vi.useFakeTimers()
    let mergeCalls = 0
    scriptExec((file, args) => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
        mergeCalls += 1
        return mergeCalls === 1 ? { error: ghError('gh: not mergeable yet') } : { stdout: 'merged' }
      }
      return happyPath(file, args)
    })

    const pending = publishAndMerge({ ...baseOpts, autoMerge: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(mergeCalls).toBe(1) // 首次合并失败，进入 30 秒等待

    await vi.advanceTimersByTimeAsync(29_999)
    expect(mergeCalls).toBe(1) // 30 秒未到不重试

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ merged: true })
    expect(mergeCalls).toBe(2) // 30 秒后重试一次成功
  })

  it('重试仍失败：抛错并保留 gh 原始输出，且重试恰好一次', async () => {
    let mergeCalls = 0
    scriptExec((file, args) => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
        mergeCalls += 1
        return { error: ghError('gh: mergeability check failed: pull request is not mergeable') }
      }
      return happyPath(file, args)
    })

    await expect(
      publishAndMerge({ ...baseOpts, autoMerge: true, retryDelayMs: 1 }),
    ).rejects.toThrow('gh pr 失败: gh: mergeability check failed: pull request is not mergeable')
    expect(mergeCalls).toBe(2)
  })

  it('git push 失败：错误向上传播，不进入建 PR 阶段', async () => {
    scriptExec((file, args) => {
      if (file === 'git' && args[0] === 'push') return { error: new Error('push rejected') }
      return happyPath(file, args)
    })

    await expect(publishAndMerge({ ...baseOpts, autoMerge: true })).rejects.toThrow('push rejected')
    expect(execFileMock.mock.calls.some(([file]) => file === 'gh')).toBe(false)
  })
})

describe('publishAndMerge 验证门（issue #22）', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    scriptExec(happyPath)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** 零退出：临时 worktree 建/删 + /bin/sh -c 正常返回 */
  it('verifyCommand 零退出：验证在 push 前的分支临时 worktree 执行，发布正常继续', async () => {
    const shCalls: string[][] = []
    scriptExec((file, args) => {
      if (file === '/bin/sh' && args[0] === '-c') {
        shCalls.push(args)
        return { stdout: 'ok' }
      }
      return happyPath(file, args)
    })

    const result = await publishAndMerge({ ...baseOpts, verifyCommand: 'pnpm typecheck' })

    expect(result.merged).toBe(false)
    expect(shCalls).toEqual([['-c', 'pnpm typecheck']])
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    // 顺序：清理遗留 → 建临时 worktree → 执行验证 → 清理 worktree → push → 建 PR
    expect(calls[0]).toEqual([
      'git',
      'worktree remove --force /tmp/project/.sandcastle/worktrees/.verify-agent-issue-21',
    ])
    expect(calls[1]).toEqual([
      'git',
      'worktree add --force /tmp/project/.sandcastle/worktrees/.verify-agent-issue-21 agent/issue-21',
    ])
    expect(calls[2]).toEqual(['/bin/sh', '-c pnpm typecheck'])
    expect(calls[3]).toEqual([
      'git',
      'worktree remove --force /tmp/project/.sandcastle/worktrees/.verify-agent-issue-21',
    ])
    expect(calls).toContainEqual(['git', 'push -u origin agent/issue-21'])
    expect(calls).toContainEqual([
      'gh',
      'pr create --base main --head agent/issue-21 --title fix: issue #21 test --body Closes #21',
    ])
  })

  /** 非零退出：/bin/sh -c 抛错（code 非 0） */
  it('verifyCommand 非零退出：抛 VerifyFailedError，不 push 不建 PR（不发版）', async () => {
    scriptExec((file, args) => {
      if (file === '/bin/sh' && args[0] === '-c') {
        return {
          error: Object.assign(new Error('typecheck failed'), {
            code: 1,
            stderr: 'error TS2322: type mismatch',
          }),
        }
      }
      return happyPath(file, args)
    })

    const err = await publishAndMerge({ ...baseOpts, verifyCommand: 'pnpm typecheck' }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(VerifyFailedError)
    expect((err as Error).message).toMatch(/验证命令「pnpm typecheck」失败/)
    expect((err as Error).message).toMatch(/error TS2322: type mismatch/)

    // 非零退出后：git push 与 gh 均未被调用（临时 worktree 仍被清理）
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    expect(calls.some(([file, a]) => file === 'git' && a.startsWith('push'))).toBe(false)
    expect(calls.some(([file]) => file === 'gh')).toBe(false)
    expect(calls.some(([file, a]) => file === 'git' && a.startsWith('worktree remove'))).toBe(true)
  })

  /** 默认关闭：不配置 verifyCommand 时行为与现状一致，不执行验证命令 */
  it('默认关闭（未配置 verifyCommand）：不执行验证命令，直接进入 push', async () => {
    await publishAndMerge(baseOpts)
    const calls = execFileMock.mock.calls.map(([file]) => file)
    expect(calls).not.toContain('/bin/sh')
    expect(calls[0]).toBe('git')
    // 无临时 worktree 操作
    expect(calls.filter((f) => f === 'git')).toHaveLength(1)
  })
})
