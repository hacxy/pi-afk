import type { Issue } from '../src/issues.js'

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { DEFAULT_GLOBAL_CONFIG } from '../src/config.js'
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

/** 正常路径脚本：git log（进度锚点）→ git fetch（基线刷新）→ push → gh PR / 留言 */
const happyPath: (file: string, args: string[]) => ScriptResult = (file, args) => {
  if (file === 'git' && args[0] === 'log') return { stdout: 'abc123 2024-01-01 Ralph: seed' }
  if (file === 'git' && args[0] === 'fetch') return { stdout: '' }
  if (file === 'git' && args[0] === 'push') return { stdout: 'ok' }
  if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
    return { stdout: 'https://github.com/hacxy/pi-afk/pull/42' }
  }
  if (file === 'gh' && args[0] === 'issue' && args[1] === 'comment') return { stdout: '' }
  if (file === 'git' && args[0] === 'worktree') return { stdout: '' }
  return { error: new Error(`unexpected call: ${file} ${args.join(' ')}`) }
}

const issue22: Issue = { number: 22, title: 'issue 22', body: 'body', comments: [] }

function makeOpts(verifyCommand?: string, iterations = 2): LoopOptions {
  return {
    projectDir: dir,
    iterations,
    config: { ...DEFAULT_GLOBAL_CONFIG, verifyCommand },
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

    const events = await processIssue(issue22, makeOpts('pnpm typecheck'))

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

    const events = await processIssue(issue22, makeOpts('pnpm typecheck'))

    expect(events.some((e) => e.type === 'verify-failed')).toBe(false)
    expect(events.find((e) => e.type === 'pull-request')).toMatchObject({ prNumber: 42 })
  })

  it('默认关闭（无 verifyCommand）：不执行验证命令，直接发布（行为不变）', async () => {
    const events = await processIssue(issue22, makeOpts())

    expect(events.some((e) => e.type === 'pull-request')).toBe(true)
    expect(execFileMock.mock.calls.some(([file]) => file === '/bin/sh')).toBe(false)
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

    const events = await runAfkLoop(makeOpts('pnpm typecheck'))

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
