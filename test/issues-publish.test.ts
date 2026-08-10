import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  publishAndMerge,
  publishConflictFallback,
  VerifyFailedError,
  buildPresyncConflictComment,
} from '../src/issues.js'
import { appendLog } from '../src/log.js'

/**
 * 发布流水线（T8，issue #21）+ 验证门（T12，issue #22）+ 预同步（T11，issue #23）
 * + resolve run 冲突化解（T13，issue #25）：
 * 预同步 origin/main（冲突时保留冲突现场、延后兜底）→（T13 派发 resolve run）
 * → push → create PR →（可选）squash 合并 + 30s 重试。
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

vi.mock('../src/log.js', () => ({
  appendLog: vi.fn(),
}))

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

/** 正常路径脚本：预同步（fetch 刷新 main → 分支临时 worktree 内 merge 干净）→ push → PR 创建 → merge 成功 */
const happyPath: (file: string, args: string[]) => ScriptResult = (file, args) => {
  if (file === 'git' && args[0] === 'fetch') return { stdout: '' }
  if (file === 'git' && args[0] === 'merge') return { stdout: 'Merged' }
  if (file === 'git' && args[0] === 'push') return { stdout: 'ok' }
  if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
    return { stdout: 'https://github.com/hacxy/pi-afk/pull/42' }
  }
  if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') return { stdout: 'merged' }
  if (file === 'gh' && args[0] === 'pr' && args[1] === 'comment') return { stdout: '' }
  if (file === 'git' && args[0] === 'worktree') return { stdout: '' }
  return { error: new Error(`unexpected call: ${file} ${args.join(' ')}`) }
}

const baseOpts = {
  branch: 'agent/issue-21',
  title: 'fix: issue #21 test',
  body: 'Closes #21',
  projectDir: '/tmp/project',
}

/** 预同步 worktree 路径（T13：复用沙箱 worktree 路径——resolve run 的 bind-mount 直接可见冲突状态） */
const presyncWorktree = '/tmp/project/.sandcastle/worktrees/agent-issue-21'

describe('publishAndMerge', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    scriptExec(happyPath)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('autoMerge 关闭：预同步（fetch → worktree 内 merge）→ 只推送 + 建 PR，不触发合并', async () => {
    const result = await publishAndMerge({ ...baseOpts, autoMerge: false })

    expect(result.merged).toBe(false)
    expect(result.pr.number).toBe(42)
    expect(result.pr.url).toBe('https://github.com/hacxy/pi-afk/pull/42')
    expect(result.presyncConflict).toBeUndefined()
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    // 预同步合并发生在 push 之前：fetch 刷新 main → 建分支临时 worktree → merge（干净）→ 清理 → push → 建 PR
    expect(calls).toEqual([
      ['git', 'fetch origin main'],
      ['git', `worktree remove --force ${presyncWorktree}`],
      ['git', `worktree add --force ${presyncWorktree} agent/issue-21`],
      ['git', 'merge --no-edit origin/main'],
      ['git', `worktree remove --force ${presyncWorktree}`],
      ['git', 'push -u origin agent/issue-21'],
      [
        'gh',
        'pr create --base main --head agent/issue-21 --title fix: issue #21 test --body Closes #21',
      ],
    ])
    // merge 在分支 worktree 内执行（宿主主工作区不动）
    const mergeCall = execFileMock.mock.calls.find(
      ([file, args]) => file === 'git' && args.join(' ') === 'merge --no-edit origin/main',
    )
    expect(mergeCall?.[2]).toMatchObject({ cwd: presyncWorktree })
  })

  it('autoMerge 开启：预同步 → push → 建 PR → squash 合并全流程跑通', async () => {
    const result = await publishAndMerge({ ...baseOpts, autoMerge: true })

    expect(result.merged).toBe(true)
    expect(result.presyncConflict).toBeUndefined()
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    expect(calls).toEqual([
      ['git', 'fetch origin main'],
      ['git', `worktree remove --force ${presyncWorktree}`],
      ['git', `worktree add --force ${presyncWorktree} agent/issue-21`],
      ['git', 'merge --no-edit origin/main'],
      ['git', `worktree remove --force ${presyncWorktree}`],
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

  /** 零退出：预同步合并后，在 push 前的分支临时 worktree 执行验证，发布正常继续 */
  it('verifyCommand 零退出：验证在预同步合并之后、push 之前执行，发布正常继续', async () => {
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
    // 顺序：预同步（fetch → 建临时 worktree → merge → 清理）→ 验证门（建临时 worktree → 验证 → 清理）→ push → 建 PR
    expect(calls).toEqual([
      ['git', 'fetch origin main'],
      ['git', `worktree remove --force ${presyncWorktree}`],
      ['git', `worktree add --force ${presyncWorktree} agent/issue-21`],
      ['git', 'merge --no-edit origin/main'],
      ['git', `worktree remove --force ${presyncWorktree}`],
      ['git', 'worktree remove --force /tmp/project/.sandcastle/worktrees/.verify-agent-issue-21'],
      [
        'git',
        'worktree add --force /tmp/project/.sandcastle/worktrees/.verify-agent-issue-21 agent/issue-21',
      ],
      ['/bin/sh', '-c pnpm typecheck'],
      ['git', 'worktree remove --force /tmp/project/.sandcastle/worktrees/.verify-agent-issue-21'],
      ['git', 'push -u origin agent/issue-21'],
      [
        'gh',
        'pr create --base main --head agent/issue-21 --title fix: issue #21 test --body Closes #21',
      ],
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

    // 非零退出后：git push 与 gh 均未被调用（预同步与验证的临时 worktree 仍被清理）
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    expect(calls.some(([file, a]) => file === 'git' && a.startsWith('push'))).toBe(false)
    expect(calls.some(([file]) => file === 'gh')).toBe(false)
    expect(calls.some(([file, a]) => file === 'git' && a.startsWith('worktree remove'))).toBe(true)
  })

  /** 默认关闭：不配置 verifyCommand 时行为与现状一致，不执行验证命令 */
  it('默认关闭（未配置 verifyCommand）：不执行验证命令，预同步后直接 push', async () => {
    await publishAndMerge(baseOpts)
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    const has = (target: string) => calls.some(([file, a]) => file === 'git' && a === target)
    expect(calls.some(([file]) => file === '/bin/sh')).toBe(false)
    // 预同步照常执行（fetch + 分支 worktree 内 merge），但无 .verify- 临时 worktree
    expect(has('merge --no-edit origin/main')).toBe(true)
    expect(calls.some(([file, a]) => file === 'git' && a.includes('.verify-'))).toBe(false)
    expect(has('push -u origin agent/issue-21')).toBe(true)
  })
})

describe('publishAndMerge 预同步（issue #23）', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    scriptExec(happyPath)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * 冲突路径（T13 前置）：merge 失败 → 取未合并路径清单 + 被合并提交 SHA →
   * 保留冲突现场（不 abort、不删 worktree，供 resolve run 复用直接可见）→
   * 返回 presyncConflict，不 push 不建 PR（兜底延后到 resolve 失败）。
   */
  it('合并冲突：保留冲突现场 + 返回 presyncConflict（含文件清单与 mergeSha），不 push 不建 PR', async () => {
    scriptExec((file, args) => {
      if (file === 'git' && args[0] === 'merge' && args[1] === '--no-edit') {
        return {
          error: Object.assign(new Error('merge failed'), {
            code: 1,
            stderr: 'CONFLICT (content): Merge conflict in src/foo.ts',
          }),
        }
      }
      if (file === 'git' && args[0] === 'diff') {
        return { stdout: 'src/foo.ts\ntest/foo.test.ts' }
      }
      if (file === 'git' && args[0] === 'rev-parse') {
        return { stdout: 'a1b2c3d4e5f6\n' }
      }
      return happyPath(file, args)
    })

    // autoMerge 开启时冲突也不触发合并：冲突未解，合并/推送全部延后
    const result = await publishAndMerge({ ...baseOpts, autoMerge: true })

    expect(result.merged).toBe(false)
    expect(result.pr).toBeUndefined()
    expect(result.presyncConflict).toEqual({
      files: ['src/foo.ts', 'test/foo.test.ts'],
      mergeSha: 'a1b2c3d4e5f6',
    })
    // 冲突路径不 push、不建 PR、不留言（兜底由 resolve 失败时的 publishConflictFallback 承担）
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    expect(calls.some(([f, a]) => f === 'git' && a.startsWith('push'))).toBe(false)
    expect(calls.some(([f]) => f === 'gh')).toBe(false)
    // 顺序：fetch → 建 worktree → merge 冲突 → diff 取清单 → rev-parse MERGE_HEAD；
    // 不 abort、不删 worktree（冲突现场保留在沙箱 worktree，供 resolve run 复用）
    expect(calls).toEqual([
      ['git', 'fetch origin main'],
      ['git', `worktree remove --force ${presyncWorktree}`],
      ['git', `worktree add --force ${presyncWorktree} agent/issue-21`],
      ['git', 'merge --no-edit origin/main'],
      ['git', 'diff --name-only --diff-filter=U'],
      ['git', 'rev-parse MERGE_HEAD'],
    ])
  })

  /** mergeSha 获取失败（无 MERGE_HEAD 等）：降级为占位文本，不阻断冲突路径 */
  it('合并冲突且 rev-parse 失败：mergeSha 降级占位文本，仍返回 presyncConflict', async () => {
    scriptExec((file, args) => {
      if (file === 'git' && args[0] === 'merge' && args[1] === '--no-edit') {
        return {
          error: Object.assign(new Error('merge conflict'), { code: 1, stderr: 'CONFLICT' }),
        }
      }
      if (file === 'git' && args[0] === 'diff') return { stdout: 'src/foo.ts' }
      if (file === 'git' && args[0] === 'rev-parse') {
        return { error: new Error('fatal: ambiguous argument MERGE_HEAD') }
      }
      return happyPath(file, args)
    })

    const result = await publishAndMerge(baseOpts)
    expect(result.presyncConflict).toEqual({ files: ['src/foo.ts'], mergeSha: '（未知）' })
  })

  /** 非冲突失败（如 origin/main 缺失）：跳过预同步，照常 push + PR（行为同现状），不留言 */
  it('merge 非冲突失败（如 origin/main 缺失）：跳过预同步，照常 push + PR', async () => {
    scriptExec((file, args) => {
      if (file === 'git' && args[0] === 'merge' && args[1] === '--no-edit') {
        return {
          error: new Error(
            "fatal: 'origin/main' is not a commit and a branch 'origin/main' could not be found",
          ),
        }
      }
      if (file === 'git' && args[0] === 'diff') return { stdout: '' }
      if (file === 'git' && args[0] === 'merge' && args[1] === '--abort') {
        return { error: new Error('fatal: There is no merge to abort') }
      }
      return happyPath(file, args)
    })

    const result = await publishAndMerge({ ...baseOpts, autoMerge: false })

    expect(result.merged).toBe(false)
    expect(result.presyncConflict).toBeUndefined()
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    expect(calls.some(([f, a]) => f === 'gh' && a.startsWith('pr create'))).toBe(true)
    expect(calls.some(([f, a]) => f === 'gh' && a.startsWith('pr comment'))).toBe(false)
  })

  /** fetch 失败降级：仍用已有 origin/main ref 合并，正常发布（不阻断） */
  it('预同步 fetch 失败：降级用已有 ref 继续合并，正常发布并记日志', async () => {
    scriptExec((file, args) => {
      if (file === 'git' && args[0] === 'fetch') {
        return { error: new Error('network error') }
      }
      return happyPath(file, args)
    })

    const result = await publishAndMerge({ ...baseOpts, autoMerge: false })

    expect(result.merged).toBe(false)
    expect(result.presyncConflict).toBeUndefined()
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    expect(calls.some(([f, a]) => f === 'git' && a === 'merge --no-edit origin/main')).toBe(true)
    expect(calls.some(([f, a]) => f === 'gh' && a.startsWith('pr create'))).toBe(true)
    expect(appendLog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'presync-fetch-failed', branch: 'agent/issue-21' }),
    )
  })

  /** 冲突留言正文：纯函数，包含分支名、冲突文件清单与下一步建议 */
  it('冲突留言正文：包含分支名、冲突文件清单与下一步建议', () => {
    const body = buildPresyncConflictComment({
      branch: 'agent/issue-21',
      files: ['src/foo.ts', 'test/foo.test.ts'],
    })
    expect(body).toContain('agent/issue-21')
    expect(body).toContain('`src/foo.ts`')
    expect(body).toContain('`test/foo.test.ts`')
    expect(body).toContain('冲突文件（2）')
    expect(body).toContain('建议下一步')
  })
})

describe('publishConflictFallback（T11 兜底：T13 resolve 失败时调用）', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    scriptExec(happyPath)
  })

  it('push + 建 PR + PR 留言冲突文件清单，不 autoMerge、不抛错', async () => {
    const { pr } = await publishConflictFallback({
      branch: 'agent/issue-21',
      title: 'fix: issue #21 test',
      body: 'Closes #21',
      projectDir: '/tmp/project',
      files: ['src/foo.ts', 'test/foo.test.ts'],
    })

    expect(pr.number).toBe(42)
    const calls = execFileMock.mock.calls.map(([file, args]) => [file, args.join(' ')])
    // push → 建 PR → PR 留言冲突清单（不触发合并）
    expect(calls[0]).toEqual(['git', 'push -u origin agent/issue-21'])
    expect(calls[1]).toEqual([
      'gh',
      'pr create --base main --head agent/issue-21 --title fix: issue #21 test --body Closes #21',
    ])
    expect(calls[2][0]).toBe('gh')
    expect(calls[2][1]).toMatch(/^pr comment 42 --body /)
    expect(calls[2][1]).toContain('src/foo.ts')
    expect(calls[2][1]).toContain('test/foo.test.ts')
    expect(
      execFileMock.mock.calls.some(
        ([file, args]) => file === 'gh' && args[0] === 'pr' && args[1] === 'merge',
      ),
    ).toBe(false)
  })
})
