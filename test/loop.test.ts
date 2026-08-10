import type { Issue } from '../src/issues.js'

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { DEFAULT_GLOBAL_CONFIG, type GlobalConfig } from '../src/config.js'
import { isHitlIssue } from '../src/issues.js'
import { pickIssue, processIssue, runAfkLoop, type LoopOptions } from '../src/loop.js'
import { runIssueInSandbox } from '../src/sandbox.js'

/**
 * processIssue / runAfkLoop（issue #22 验证门接线）：
 * 仅在进程边界（execFile）与沙箱边界（runIssueInSandbox）打桩，
 * 走真实的 gh/git 调用路径与发布流水线。
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

vi.mock('../src/sandbox.js', () => ({
  runIssueInSandbox: vi.fn(),
  hostPnpmVersion: vi.fn(() => '9.0.0'),
}))

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

/** 正常路径脚本：git log（进度锚点）→ git fetch（基线刷新）→ 预同步（worktree 内 merge）→ push → gh PR / 留言 */
const happyPath: (file: string, args: string[]) => ScriptResult = (file, args) => {
  if (file === 'git' && args[0] === 'log') return { stdout: 'abc123 2024-01-01 Ralph: seed' }
  if (file === 'git' && args[0] === 'fetch') return { stdout: '' }
  if (file === 'git' && args[0] === 'merge') return { stdout: 'Merged' }
  if (file === 'git' && args[0] === 'diff') return { stdout: '' }
  if (file === 'git' && args[0] === 'push') return { stdout: 'ok' }
  if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
    return { stdout: 'https://github.com/hacxy/pi-afk/pull/42' }
  }
  if (file === 'gh' && args[0] === 'pr' && args[1] === 'comment') return { stdout: '' }
  if (file === 'gh' && args[0] === 'issue' && args[1] === 'comment') return { stdout: '' }
  if (file === 'git' && args[0] === 'worktree') return { stdout: '' }
  return { error: new Error(`unexpected call: ${file} ${args.join(' ')}`) }
}

const issue22: Issue = { number: 22, title: 'issue 22', body: 'body', comments: [] }

function makeOpts(overrides: Partial<GlobalConfig> = {}, iterations = 2): LoopOptions {
  return {
    projectDir: dir,
    iterations,
    config: { ...DEFAULT_GLOBAL_CONFIG, ...overrides },
    deepseekKey: 'test-key',
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'afk-loop-'))
  execFileMock.mockReset()
  scriptExec(happyPath)
  vi.mocked(runIssueInSandbox).mockReset()
  vi.mocked(runIssueInSandbox).mockResolvedValue({
    outcome: { status: 'done', summary: 'all done' },
    commits: [{ sha: 'a1b2c3' }],
    stdout: '',
  })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('processIssue 验证门（issue #22）', () => {
  it('验证命令非零退出：留言说明验证失败、不建 PR、返回 verify-failed 事件', async () => {
    scriptExec((file, args) => {
      if (file === '/bin/sh' && args[0] === '-c') {
        return {
          error: Object.assign(new Error('typecheck failed'), { code: 1, stderr: 'TS error' }),
        }
      }
      return happyPath(file, args)
    })

    const events = await processIssue(issue22, makeOpts({ verifyCommand: 'pnpm typecheck' }))

    expect(events.some((e) => e.type === 'verify-failed')).toBe(true)
    expect(events.some((e) => e.type === 'pull-request')).toBe(false)
    // 留言：gh issue comment 被调用，正文说明验证失败原因
    const commentArgs = execFileMock.mock.calls
      .filter(([file, args]) => file === 'gh' && args[0] === 'issue' && args[1] === 'comment')
      .flatMap(([, args]) => args)
    expect(commentArgs.join(' ')).toMatch(/验证.*失败.*TS error/s)
  })

  it('验证命令零退出：正常继续发布（pull-request 事件）', async () => {
    scriptExec((file, args) => {
      if (file === '/bin/sh' && args[0] === '-c') return { stdout: 'ok' }
      return happyPath(file, args)
    })

    const events = await processIssue(issue22, makeOpts({ verifyCommand: 'pnpm typecheck' }))

    expect(events.some((e) => e.type === 'verify-failed')).toBe(false)
    expect(events.find((e) => e.type === 'pull-request')).toMatchObject({ prNumber: 42 })
  })

  it('默认关闭（无 verifyCommand）：不执行验证命令，直接发布（行为不变）', async () => {
    const events = await processIssue(issue22, makeOpts())

    expect(events.some((e) => e.type === 'pull-request')).toBe(true)
    expect(execFileMock.mock.calls.some(([file]) => file === '/bin/sh')).toBe(false)
  })
})

describe('runAfkLoop 预同步冲突 → resolve run（issue #25）', () => {
  /** 冲突脚本：首次预同步 merge 冲突（保留现场），后续 merge 干净；含 rev-parse 供 MERGE_HEAD */
  const conflictScript: (file: string, args: string[]) => ScriptResult = (file, args) => {
    if (file === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return { stdout: JSON.stringify([issue22]) }
    }
    if (file === 'git' && args[0] === 'merge' && args[1] === '--no-edit') {
      return {
        error: Object.assign(new Error('merge conflict'), {
          code: 1,
          stderr: 'CONFLICT (content): Merge conflict in src/foo.ts',
        }),
      }
    }
    if (file === 'git' && args[0] === 'diff') {
      return { stdout: 'src/foo.ts' }
    }
    if (file === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'deadbeef\n' }
    }
    return happyPath(file, args)
  }

  it('resolve 成功：冲突 → 派发 resolve run（复用分支/无 baseBranch + resolve 模板）→ push + PR + 自动合并', async () => {
    let mergeCalls = 0
    scriptExec((file, args) => {
      if (file === 'git' && args[0] === 'merge' && args[1] === '--no-edit') {
        mergeCalls += 1
        // 首次预同步冲突；resolve 成功后的第二次发布预同步干净
        return mergeCalls === 1
          ? {
              error: Object.assign(new Error('merge conflict'), {
                code: 1,
                stderr: 'CONFLICT (content): Merge conflict in src/foo.ts',
              }),
            }
          : { stdout: 'Merged' }
      }
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') return { stdout: 'merged' }
      return conflictScript(file, args)
    })
    // 沙箱两次：首次实现（done+提交）+ resolve run（done+提交）
    vi.mocked(runIssueInSandbox)
      .mockResolvedValueOnce({
        outcome: { status: 'done', summary: 'all done' },
        commits: [{ sha: 'a1b2c3' }],
        stdout: '',
      })
      .mockResolvedValueOnce({
        outcome: { status: 'done', summary: 'conflicts resolved' },
        commits: [{ sha: 'r1r2r3' }],
        stdout: '',
      })

    const events = await runAfkLoop(makeOpts({ autoMerge: true }))

    // resolve run：第二次沙箱调用复用同一分支（无 baseBranch）、resolve 模板 + 冲突上下文注入
    expect(vi.mocked(runIssueInSandbox)).toHaveBeenCalledTimes(2)
    const secondCall = vi.mocked(runIssueInSandbox).mock.calls[1][0]
    expect(secondCall.branch).toBe('agent/issue-22')
    expect(secondCall.baseBranch).toBeUndefined()
    expect(secondCall.promptFile).toMatch(/resolve\.md$/)
    expect(secondCall.promptArgs).toMatchObject({
      ISSUE_NUMBER: '22',
      CONFLICT_FILES: expect.stringContaining('src/foo.ts'),
      CONFLICT_COUNT: '1',
      MERGED_SHA: 'deadbeef',
      BRANCH: 'agent/issue-22',
    })
    // resolve 成功 → 第二次发布（push + PR + 合并），PR 干净并自动合并
    expect(events.find((e) => e.type === 'presync-conflict')).toMatchObject({
      issue: issue22,
      files: ['src/foo.ts'],
    })
    expect(events.some((e) => e.type === 'pull-request')).toBe(true)
    expect(events.some((e) => e.type === 'issue-merged')).toBe(true)
    expect(events.some((e) => e.type === 'resolve-failed')).toBe(false)
    // 本轮不再拾取该 issue（→ no-more-tasks）
    expect(events.filter((e) => e.type === 'issue-picked')).toHaveLength(1)
    expect(events.some((e) => e.type === 'no-more-tasks')).toBe(true)
  })

  it('resolve 失败（blocked）：回退 T11 兜底（push + PR + 留言冲突清单），不自动合并', async () => {
    scriptExec((file, args) => {
      if (file === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: JSON.stringify([issue22]) }
      }
      return conflictScript(file, args)
    })
    vi.mocked(runIssueInSandbox)
      .mockResolvedValueOnce({
        outcome: { status: 'done', summary: 'all done' },
        commits: [{ sha: 'a1b2c3' }],
        stdout: '',
      })
      .mockResolvedValueOnce({
        outcome: { status: 'blocked', summary: '无法获取关键上下文' },
        commits: [],
        stdout: '',
      })

    const events = await runAfkLoop(makeOpts({ autoMerge: true }))

    expect(vi.mocked(runIssueInSandbox)).toHaveBeenCalledTimes(2)
    // 回退兜底：push + 建 PR + PR 留言冲突清单，不自动合并（冲突未解）
    expect(events.some((e) => e.type === 'pull-request')).toBe(true)
    expect(events.find((e) => e.type === 'resolve-failed')).toMatchObject({
      issue: issue22,
      reason: expect.stringContaining('blocked'),
    })
    const prComment = execFileMock.mock.calls
      .filter(([file, args]) => file === 'gh' && args[0] === 'pr' && args[1] === 'comment')
      .flatMap(([, args]) => args)
    expect(prComment.join(' ')).toMatch(/src\/foo\.ts/)
    expect(
      execFileMock.mock.calls.some(
        ([file, args]) => file === 'gh' && args[0] === 'pr' && args[1] === 'merge',
      ),
    ).toBe(false)
    expect(events.some((e) => e.type === 'issue-merged')).toBe(false)
    expect(events.some((e) => e.type === 'no-more-tasks')).toBe(true)
  })

  it('resolve 报告 done 但零提交：按失败处理，回退 T11 兜底', async () => {
    scriptExec((file, args) => {
      if (file === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: JSON.stringify([issue22]) }
      }
      return conflictScript(file, args)
    })
    vi.mocked(runIssueInSandbox)
      .mockResolvedValueOnce({
        outcome: { status: 'done', summary: 'all done' },
        commits: [{ sha: 'a1b2c3' }],
        stdout: '',
      })
      .mockResolvedValueOnce({
        outcome: { status: 'done', summary: '声称完成但没提交' },
        commits: [],
        stdout: '',
      })

    const events = await runAfkLoop(makeOpts({ autoMerge: true }))

    expect(events.find((e) => e.type === 'resolve-failed')).toMatchObject({
      issue: issue22,
      reason: expect.stringContaining('零提交'),
    })
    expect(events.some((e) => e.type === 'pull-request')).toBe(true)
    expect(
      execFileMock.mock.calls.some(
        ([file, args]) => file === 'gh' && args[0] === 'pr' && args[1] === 'merge',
      ),
    ).toBe(false)
  })

  it('resolve 沙箱错误（docker 不可用）：按失败回退兜底，不抛错不阻塞循环', async () => {
    scriptExec((file, args) => {
      if (file === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: JSON.stringify([issue22]) }
      }
      return conflictScript(file, args)
    })
    vi.mocked(runIssueInSandbox)
      .mockResolvedValueOnce({
        outcome: { status: 'done', summary: 'all done' },
        commits: [{ sha: 'a1b2c3' }],
        stdout: '',
      })
      .mockRejectedValueOnce(new Error('docker daemon unreachable'))

    const events = await runAfkLoop(makeOpts())

    expect(events.find((e) => e.type === 'resolve-failed')).toMatchObject({
      issue: issue22,
      reason: expect.stringContaining('docker daemon unreachable'),
    })
    // 兜底 PR 照常建立（冲突留言），本轮结束，不抛错
    expect(events.some((e) => e.type === 'pull-request')).toBe(true)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'no-more-tasks')).toBe(true)
  })
})

describe('runAfkLoop 验证失败本轮停止（issue #22）', () => {
  it('验证失败后该 issue 进入本轮跳过集合，后续迭代不再拾取', async () => {
    scriptExec((file, args) => {
      if (file === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: JSON.stringify([issue22]) }
      }
      if (file === '/bin/sh' && args[0] === '-c') {
        return { error: Object.assign(new Error('boom'), { code: 1, stderr: 'verify failed' }) }
      }
      return happyPath(file, args)
    })

    const events = await runAfkLoop(makeOpts({ verifyCommand: 'pnpm typecheck' }))

    // 只拾取一次；下一轮不再处理该 issue → no-more-tasks
    expect(events.filter((e) => e.type === 'issue-picked')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'verify-failed')).toHaveLength(1)
    expect(events.some((e) => e.type === 'no-more-tasks')).toBe(true)
  })
})

const makeIssue = (number: number, body = 'body'): Issue => ({
  number,
  title: `issue ${number}`,
  body,
  comments: [],
})

describe('processIssue 收敛检查（issue #24）', () => {
  /** 脚本化 gh pr list 返回指定 PR 列表 */
  const withPrList = (prs: unknown[]) => (file: string, args: string[]) => {
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return { stdout: JSON.stringify(prs) }
    }
    return happyPath(file, args)
  }

  const issueCommentArgs = () =>
    execFileMock.mock.calls
      .filter(([file, args]) => file === 'gh' && args[0] === 'issue' && args[1] === 'comment')
      .flatMap(([, args]) => args)
      .join(' ')

  it('merged 场景：issue 留言「已由 PR #N 处理」且不启动沙箱', async () => {
    scriptExec(withPrList([{ number: 29, state: 'MERGED', mergeable: 'UNKNOWN' }]))

    const events = await processIssue(issue22, makeOpts({ autoMerge: true }))

    expect(vi.mocked(runIssueInSandbox)).not.toHaveBeenCalled()
    expect(events).toEqual([{ type: 'pr-exists-merged', issue: issue22, prNumber: 29 }])
    expect(issueCommentArgs()).toMatch(/已由 PR #29 处理.*本轮跳过/s)
  })

  it('open+clean + autoMerge 关：issue 留言「已有 PR #N 待人工合并」，不合并、不启动沙箱', async () => {
    scriptExec(withPrList([{ number: 42, state: 'OPEN', mergeable: 'MERGEABLE' }]))

    const events = await processIssue(issue22, makeOpts({ autoMerge: false }))

    expect(vi.mocked(runIssueInSandbox)).not.toHaveBeenCalled()
    expect(events).toEqual([{ type: 'pr-pending-manual-merge', issue: issue22, prNumber: 42 }])
    expect(issueCommentArgs()).toMatch(/已有 PR #42 待人工合并/s)
    // 不自动合并（防「下次 run 悄悄合掉未 review 的 PR」）
    expect(
      execFileMock.mock.calls.some(
        ([file, args]) => file === 'gh' && args[0] === 'pr' && args[1] === 'merge',
      ),
    ).toBe(false)
  })

  it('open+dirty 场景：PR 留言说明冲突，不启动沙箱', async () => {
    scriptExec(withPrList([{ number: 42, state: 'OPEN', mergeable: 'CONFLICTING' }]))

    const events = await processIssue(issue22, makeOpts({ autoMerge: true }))

    expect(vi.mocked(runIssueInSandbox)).not.toHaveBeenCalled()
    expect(events).toEqual([{ type: 'pr-conflict-skip', issue: issue22, prNumber: 42 }])
    const prComment = execFileMock.mock.calls
      .filter(([file, args]) => file === 'gh' && args[0] === 'pr' && args[1] === 'comment')
      .flatMap(([, args]) => args)
      .join(' ')
    expect(prComment).toMatch(/冲突/s)
  })

  it('open+clean + autoMerge 开：直接合并现有 PR（残留合并闭环），不启动沙箱', async () => {
    scriptExec((file, args) => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') return { stdout: 'merged' }
      return withPrList([{ number: 42, state: 'OPEN', mergeable: 'MERGEABLE' }])(file, args)
    })

    const events = await processIssue(issue22, makeOpts({ autoMerge: true }))

    expect(vi.mocked(runIssueInSandbox)).not.toHaveBeenCalled()
    expect(events).toEqual([{ type: 'issue-merged', issue: issue22, prNumber: 42 }])
    expect(
      execFileMock.mock.calls.some(
        ([file, args]) =>
          file === 'gh' && args.join(' ') === 'pr merge 42 --squash --delete-branch',
      ),
    ).toBe(true)
  })

  it('无 PR：proceed，正常进沙箱（行为不变）', async () => {
    scriptExec(withPrList([]))

    const events = await processIssue(issue22, makeOpts())

    expect(vi.mocked(runIssueInSandbox)).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.type === 'pull-request')).toBe(true)
  })
})

describe('runAfkLoop 循环内去重（issue #24）', () => {
  it('done 结果后 issue 进跳过集合：列表仍显示 open（关闭状态传播延迟）也不再重复 pick', async () => {
    scriptExec((file, args) => {
      if (file === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        // 复现事故场景：merge 后 issue 列表因关闭状态传播延迟仍返回该 issue（stale open）
        return { stdout: JSON.stringify([issue22]) }
      }
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') return { stdout: 'merged' }
      return happyPath(file, args)
    })

    const events = await runAfkLoop(makeOpts({ autoMerge: true }))

    // 只拾取一次（done 后进跳过集合，下一迭代不再 pick）→ 第二次迭代无候选 → no-more-tasks
    expect(events.filter((e) => e.type === 'issue-picked')).toHaveLength(1)
    expect(events.some((e) => e.type === 'issue-merged')).toBe(true)
    expect(events.some((e) => e.type === 'no-more-tasks')).toBe(true)
  })

  it('收敛跳过（merged）后同样进跳过集合：同一 run 内不重复留言', async () => {
    scriptExec((file, args) => {
      if (file === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: JSON.stringify([issue22]) }
      }
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return { stdout: JSON.stringify([{ number: 29, state: 'MERGED', mergeable: 'UNKNOWN' }]) }
      }
      return happyPath(file, args)
    })

    const events = await runAfkLoop(makeOpts())

    expect(events.filter((e) => e.type === 'pr-exists-merged')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'issue-picked')).toHaveLength(1)
    expect(events.some((e) => e.type === 'no-more-tasks')).toBe(true)
  })
})

describe('pickIssue', () => {
  it('返回编号最小的开放 issue', () => {
    const issues = [makeIssue(5), makeIssue(3), makeIssue(8)]
    expect(pickIssue(issues, new Set())?.number).toBe(3)
  })

  it('跳过集合内的 issue', () => {
    const issues = [makeIssue(5), makeIssue(3), makeIssue(8)]
    expect(pickIssue(issues, new Set([3]))?.number).toBe(5)
    expect(pickIssue(issues, new Set([3, 5, 8]))).toBeNull()
  })

  it('空列表返回 null', () => {
    expect(pickIssue([], new Set())).toBeNull()
  })

  it('跳过 HITL 切片（防 label 误用）', () => {
    const afk = makeIssue(1)
    const hitl = makeIssue(2, '## 类型（Type）\n\nHITL')
    const issues = [hitl, afk]
    expect(pickIssue(issues, new Set())?.number).toBe(1)
    expect(pickIssue([hitl], new Set())).toBeNull()
  })
})

describe('isHitlIssue', () => {
  it('识别中文/英文 HITL 标记', () => {
    expect(isHitlIssue(makeIssue(1, '## 类型（Type）\n\nHITL'))).toBe(true)
    expect(isHitlIssue(makeIssue(2, '## Type\n\nHITL'))).toBe(true)
    expect(isHitlIssue(makeIssue(3, '## 类型（Type）\n\nAFK'))).toBe(false)
    expect(isHitlIssue(makeIssue(4, '普通 issue'))).toBe(false)
  })
})
