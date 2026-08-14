import type { Issue } from '../src/issues.js'

import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runAfk } from '../src/loop.js'

vi.mock('../src/install.js', () => ({ installDeps: vi.fn() }))
vi.mock('../src/executor.js', () => ({ HostExecutor: vi.fn() }))
vi.mock('../src/git.js', () => ({
  archiveWorktree: vi.fn(),
  branchName: vi.fn(),
  createWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  pushBranch: vi.fn(),
  removeWorktree: vi.fn(),
}))
vi.mock('../src/issues.js', () => ({
  addComment: vi.fn(),
  addLabel: vi.fn(),
  listTodoIssues: vi.fn(),
  openPr: vi.fn(),
  removeLabel: vi.fn(),
  repoName: vi.fn(),
}))
vi.mock('../src/log.js', () => ({ currentLogFile: vi.fn(), log: vi.fn(), logError: vi.fn() }))

import { HostExecutor } from '../src/executor.js'
import {
  archiveWorktree,
  branchName,
  createWorktree,
  deleteBranch,
  pushBranch,
  removeWorktree,
} from '../src/git.js'
import { installDeps } from '../src/install.js'
import {
  addComment,
  addLabel,
  listTodoIssues,
  openPr,
  removeLabel,
  repoName,
} from '../src/issues.js'
import { currentLogFile } from '../src/log.js'

const issue: Issue = {
  number: 52,
  title: '网站链接导航去背景色',
  body: '导航链接有背景色，需要去掉。',
  labels: ['agent:todo'],
}

function okResult(stdout = ''): {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  sessionFile: string
} {
  return { exitCode: 0, stdout, stderr: '', timedOut: false, sessionFile: '/tmp/s.jsonl' }
}

interface FakeExecutor {
  runStage: ReturnType<typeof vi.fn>
}

/** HostExecutor mock 实际创建的实例（按创建顺序），断言用 */
let executors: FakeExecutor[] = []

beforeEach(() => {
  vi.clearAllMocks()
  executors = []
  vi.mocked(listTodoIssues).mockReturnValue([issue])
  vi.mocked(branchName).mockReturnValue('afk/issue-52-site-links-nav')
  vi.mocked(createWorktree).mockReturnValue('/tmp/wt')
  vi.mocked(repoName).mockReturnValue('hacxy/pi-afk')
  vi.mocked(archiveWorktree).mockReturnValue('.pi/afk/failed/afk/issue-52-site-links-nav')
  vi.mocked(currentLogFile).mockReturnValue(resolve('.pi/afk/logs/afk-test.log'))
  vi.mocked(openPr).mockReturnValue('https://github.com/hacxy/pi-afk/pull/100')
  vi.mocked(installDeps).mockResolvedValue(undefined)
  vi.mocked(HostExecutor).mockImplementation(() => {
    const executor: FakeExecutor = { runStage: vi.fn().mockResolvedValue(okResult()) }
    executors.push(executor)
    return executor as unknown as InstanceType<typeof HostExecutor>
  })
})

describe('runAfk 单阶段 pipeline（宿主后端）', () => {
  it('成功：worktree → 宿主装依赖 → 单阶段 implementer → push → 开 PR → done label + comment + 清理', async () => {
    const results = await runAfk()
    expect(results[0].status).toBe('done')

    // 宿主侧装依赖（编排层负责，agent 不自装），在 worktree 里执行
    expect(installDeps).toHaveBeenCalledTimes(1)
    expect(installDeps).toHaveBeenCalledWith('/tmp/wt')

    // 单阶段：只有 implementer，且 cwd=worktree（pi 在 worktree 里读写文件）
    const executor = executors[0]
    expect(executor).toBeDefined()
    expect(executor.runStage).toHaveBeenCalledTimes(1)
    const ctx = vi.mocked(executor.runStage).mock.calls[0][0]
    expect(ctx.stage).toBe('implementer')
    expect(ctx.cwd).toBe('/tmp/wt')
    expect(ctx.prompt).toContain('#52')

    // 宿主 push 规范命名分支
    expect(pushBranch).toHaveBeenCalledWith('/tmp/wt', 'afk/issue-52-site-links-nav')

    // 开 PR：Closes #N + base 基线分支
    expect(openPr).toHaveBeenCalledTimes(1)
    const prOpts = vi.mocked(openPr).mock.calls[0][0]
    expect(prOpts.branch).toBe('afk/issue-52-site-links-nav')
    expect(prOpts.base).toBe('main')
    expect(prOpts.title).toBe(issue.title)
    expect(prOpts.body).toContain('Closes #52')

    // label 状态机 todo → done
    expect(addLabel).toHaveBeenCalledWith(52, 'agent:done')
    expect(removeLabel).toHaveBeenCalledWith(52, 'agent:todo')

    // 成功回报：分支名 + PR 链接 + compare 链接
    expect(addComment).toHaveBeenCalledTimes(1)
    const body = vi.mocked(addComment).mock.calls[0][1]
    expect(body).toContain('afk/issue-52-site-links-nav')
    expect(body).toContain('https://github.com/hacxy/pi-afk/pull/100')
    expect(body).toContain(
      'https://github.com/hacxy/pi-afk/compare/main...afk/issue-52-site-links-nav',
    )

    // 成功清理：删 worktree + 删本地分支（远程分支留给 PR）
    expect(removeWorktree).toHaveBeenCalledWith('/tmp/wt')
    expect(deleteBranch).toHaveBeenCalledWith('afk/issue-52-site-links-nav')
    expect(archiveWorktree).not.toHaveBeenCalled()
  })

  it('失败（implementer 非零退出）：归档 worktree + 删本地分支 + 失败 comment + failed label，不 push 不开 PR', async () => {
    vi.mocked(HostExecutor).mockImplementation(() => {
      const executor: FakeExecutor = {
        runStage: vi
          .fn()
          .mockResolvedValue({ ...okResult(), exitCode: 1, stderr: 'typecheck 失败' }),
      }
      executors.push(executor)
      return executor as unknown as InstanceType<typeof HostExecutor>
    })

    const results = await runAfk()
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('implementer 退出码 1')

    expect(pushBranch).not.toHaveBeenCalled()
    expect(openPr).not.toHaveBeenCalled()

    // 失败现场归档 + 删本地分支（改回 todo 能干净重跑）
    expect(archiveWorktree).toHaveBeenCalledWith('/tmp/wt', 'afk/issue-52-site-links-nav')
    expect(deleteBranch).toHaveBeenCalledWith('afk/issue-52-site-links-nav')
    expect(removeWorktree).not.toHaveBeenCalled() // 已归档，不再 remove

    // 失败回报：阶段 + 退出码 + stderr 摘要 + 产物路径 + 重跑提示
    expect(addComment).toHaveBeenCalledTimes(1)
    const body = vi.mocked(addComment).mock.calls[0][1]
    expect(body).toContain('implementer')
    expect(body).toContain('退出码：1')
    expect(body).toContain('typecheck 失败')
    expect(body).toContain('.pi/afk/logs/afk-test.log') // 日志（已相对化）
    expect(body).toContain('.pi/afk/failed/afk/issue-52-site-links-nav') // 归档路径
    expect(body).toContain('agent:todo') // 重跑提示

    expect(addLabel).toHaveBeenCalledWith(52, 'agent:failed')
    expect(removeLabel).toHaveBeenCalledWith(52, 'agent:todo')
  })

  it('依赖安装失败 → 归档 + 删分支 + 失败 comment（阶段 install），不跑任何阶段', async () => {
    vi.mocked(installDeps).mockRejectedValue(new Error('依赖安装失败（1）'))

    const results = await runAfk()
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('依赖安装失败')
    expect(executors).toHaveLength(0) // 没创建 HostExecutor，没跑 implementer
    expect(pushBranch).not.toHaveBeenCalled()
    expect(openPr).not.toHaveBeenCalled()
    expect(archiveWorktree).toHaveBeenCalledTimes(1)
    expect(deleteBranch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(addComment).mock.calls[0][1]).toContain('install')
    expect(addLabel).toHaveBeenCalledWith(52, 'agent:failed')
  })

  it('多 issue：每个 issue 各建 worktree、各装一次依赖、各开一个 PR', async () => {
    const issue2: Issue = { ...issue, number: 53, title: '另一件事' }
    vi.mocked(listTodoIssues).mockReturnValue([issue, issue2])
    vi.mocked(branchName).mockImplementation((i) =>
      i.number === 52 ? 'afk/issue-52-site-links-nav' : 'afk/issue-53-another',
    )
    vi.mocked(createWorktree).mockImplementation((branch) => `/tmp/wt-${branch.split('-')[2]}`)

    const results = await runAfk()
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === 'done')).toBe(true)

    expect(installDeps).toHaveBeenCalledTimes(2)
    expect(openPr).toHaveBeenCalledTimes(2)
    expect(executors).toHaveLength(2)
    const stages = executors.flatMap((e) => vi.mocked(e.runStage).mock.calls.map(([c]) => c.stage))
    expect(stages).toEqual(['implementer', 'implementer'])
  })
})
