import type { Issue } from '../src/issues.js'
import type { Sandbox } from '../src/sandbox.js'

import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runAfk } from '../src/loop.js'

vi.mock('../src/sandbox.js', () => ({ createSandbox: vi.fn() }))
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
  removeLabel: vi.fn(),
  repoName: vi.fn(),
}))
vi.mock('../src/log.js', () => ({ currentLogFile: vi.fn(), log: vi.fn(), logError: vi.fn() }))

import {
  archiveWorktree,
  branchName,
  createWorktree,
  deleteBranch,
  pushBranch,
  removeWorktree,
} from '../src/git.js'
import { addComment, addLabel, listTodoIssues, removeLabel, repoName } from '../src/issues.js'
import { currentLogFile } from '../src/log.js'
import { createSandbox } from '../src/sandbox.js'

const issue: Issue = {
  number: 52,
  title: '网站链接导航去背景色',
  body: '导航链接有背景色，需要去掉。',
  labels: ['agent:todo'],
}

const plan = {
  number: 52,
  title: '网站链接导航去背景色',
  branch: 'afk/issue-52-site-links-nav',
  summary: '去掉导航链接的背景色',
  files: ['src/components/Nav.tsx'],
  acceptanceCriteria: ['导航链接无背景色'],
  steps: ['定位样式', '移除背景色', '跑测试'],
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

function makeSandbox(): Sandbox {
  return {
    name: 'afk-issue-52-site-links-nav',
    installDeps: vi.fn().mockResolvedValue(undefined),
    runStage: vi.fn().mockResolvedValue(okResult()),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
}

/** createSandbox mock 实际创建的沙箱（按创建顺序），断言用 */
let sandboxes: Sandbox[] = []

beforeEach(() => {
  vi.clearAllMocks()
  sandboxes = []
  vi.mocked(listTodoIssues).mockReturnValue([issue])
  vi.mocked(branchName).mockReturnValue('afk/issue-52-site-links-nav')
  vi.mocked(createWorktree).mockReturnValue('/tmp/wt')
  vi.mocked(repoName).mockReturnValue('hacxy/pi-afk')
  vi.mocked(archiveWorktree).mockReturnValue('.afk/failed/afk/issue-52-site-links-nav')
  vi.mocked(currentLogFile).mockReturnValue(resolve('.afk/logs/afk-test.log'))
  vi.mocked(createSandbox).mockImplementation(async () => {
    const sandbox = makeSandbox()
    sandbox.runStage = vi
      .fn()
      .mockResolvedValueOnce(okResult(JSON.stringify(plan))) // planner 输出合法 plan
      .mockResolvedValue(okResult()) // implementer / reviewer
    sandboxes.push(sandbox)
    return sandbox
  })
})

describe('runAfk 三阶段 pipeline（常驻容器）', () => {
  it('成功：每 issue 一个容器，装依赖一次，三阶段复用同一容器，push + done label + comment + 销毁', async () => {
    const results = await runAfk()
    expect(results[0].status).toBe('done')

    // 每 issue 一个常驻容器（docker run -d + docker exec 复用）
    expect(createSandbox).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(createSandbox).mock.calls[0][0]
    expect(opts.worktree).toBe('/tmp/wt')
    expect(opts.branch).toBe('afk/issue-52-site-links-nav')
    expect(opts.repoRoot).toBe(process.cwd())

    // onSandboxReady hook：容器就绪先装依赖（agent 不自装）
    const sandbox = sandboxes[0]
    expect(sandbox).toBeDefined()
    expect(sandbox.installDeps).toHaveBeenCalledTimes(1)

    // 三阶段按序复用同一容器；依赖安装发生在任何阶段之前
    expect(sandbox.runStage).toHaveBeenCalledTimes(3)
    const stages = vi.mocked(sandbox.runStage).mock.calls.map(([ctx]) => ctx.stage)
    expect(stages).toEqual(['planner', 'implementer', 'reviewer'])
    const installOrder = vi.mocked(sandbox.installDeps).mock.invocationCallOrder[0]
    const firstStageOrder = vi.mocked(sandbox.runStage).mock.invocationCallOrder[0]
    expect(installOrder).toBeLessThan(firstStageOrder)

    // 宿主 push 规范命名分支 + label 状态机 + try/finally 销毁
    expect(pushBranch).toHaveBeenCalledWith('/tmp/wt', 'afk/issue-52-site-links-nav')
    expect(addLabel).toHaveBeenCalledWith(52, 'agent:done')
    expect(removeLabel).toHaveBeenCalledWith(52, 'agent:todo')
    expect(sandbox.destroy).toHaveBeenCalledTimes(1)
    expect(removeWorktree).toHaveBeenCalledWith('/tmp/wt')

    // 成功回报：分支名 + compare 链接；本地分支清理（重跑不被卡住）
    expect(addComment).toHaveBeenCalledTimes(1)
    const body = vi.mocked(addComment).mock.calls[0][1]
    expect(body).toContain('afk/issue-52-site-links-nav')
    expect(body).toContain(
      'https://github.com/hacxy/pi-afk/compare/main...afk/issue-52-site-links-nav',
    )
    expect(deleteBranch).toHaveBeenCalledWith('afk/issue-52-site-links-nav')
    expect(archiveWorktree).not.toHaveBeenCalled()
  })

  it('失败（implementer 非零退出）：归档 worktree + 删本地分支 + 失败 comment + failed label，不 push', async () => {
    const sandbox = makeSandbox()
    sandbox.runStage = vi
      .fn()
      .mockResolvedValueOnce(okResult(JSON.stringify(plan)))
      .mockResolvedValueOnce({ ...okResult(), exitCode: 1, stderr: 'typecheck 失败' })
    vi.mocked(createSandbox).mockResolvedValue(sandbox)

    const results = await runAfk()
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('implementer 退出码 1')

    expect(sandbox.runStage).toHaveBeenCalledTimes(2) // planner + implementer，无 reviewer
    expect(pushBranch).not.toHaveBeenCalled()

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
    expect(body).toContain('.afk/logs/afk-test.log') // 日志（已相对化）
    expect(body).toContain('.afk/failed/afk/issue-52-site-links-nav') // 归档路径
    expect(body).toContain('agent:todo') // 重跑提示

    expect(addLabel).toHaveBeenCalledWith(52, 'agent:failed')
    expect(removeLabel).toHaveBeenCalledWith(52, 'agent:todo')
    expect(sandbox.destroy).toHaveBeenCalledTimes(1) // 失败也销毁，无孤儿容器
  })

  it('planner zod 校验非法重试 3 次仍失败 → 归档 + failed comment（阶段 planner）', async () => {
    const sandbox = makeSandbox()
    sandbox.runStage = vi.fn().mockResolvedValue(okResult('不是 JSON'))
    vi.mocked(createSandbox).mockResolvedValue(sandbox)

    const results = await runAfk()
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('planner')

    const stages = vi.mocked(sandbox.runStage).mock.calls.map(([ctx]) => ctx.stage)
    expect(stages).toEqual(['planner', 'planner', 'planner']) // 上限 2 次重试 = 3 次尝试
    expect(pushBranch).not.toHaveBeenCalled()
    expect(archiveWorktree).toHaveBeenCalledTimes(1)
    expect(deleteBranch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(addComment).mock.calls[0][1]).toContain('planner')
    expect(sandbox.destroy).toHaveBeenCalledTimes(1)
  })

  it('依赖安装失败 → 归档 + 删分支 + 失败 comment（阶段 install），不跑任何阶段', async () => {
    const sandbox = makeSandbox()
    sandbox.installDeps = vi.fn().mockRejectedValue(new Error('依赖安装失败（1）'))
    vi.mocked(createSandbox).mockResolvedValue(sandbox)

    const results = await runAfk()
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('依赖安装失败')
    expect(sandbox.runStage).not.toHaveBeenCalled()
    expect(archiveWorktree).toHaveBeenCalledTimes(1)
    expect(deleteBranch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(addComment).mock.calls[0][1]).toContain('install')
    expect(sandbox.destroy).toHaveBeenCalledTimes(1)
  })

  it('多 issue：每个 issue 各一个容器，依赖各装一次', async () => {
    const issue2: Issue = { ...issue, number: 53, title: '另一件事' }
    vi.mocked(listTodoIssues).mockReturnValue([issue, issue2])
    vi.mocked(branchName).mockImplementation((i) =>
      i.number === 52 ? 'afk/issue-52-site-links-nav' : 'afk/issue-53-another',
    )
    vi.mocked(createWorktree).mockImplementation((branch) => `/tmp/wt-${branch.split('-')[2]}`)

    const results = await runAfk()
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === 'done')).toBe(true)

    expect(createSandbox).toHaveBeenCalledTimes(2)
    const branches = vi.mocked(createSandbox).mock.calls.map(([opts]) => opts.branch)
    expect(branches).toEqual(['afk/issue-52-site-links-nav', 'afk/issue-53-another'])

    // 每个容器独立装依赖、独立销毁
    expect(sandboxes).toHaveLength(2)
    for (const sandbox of sandboxes) {
      expect(sandbox.installDeps).toHaveBeenCalledTimes(1)
      expect(sandbox.destroy).toHaveBeenCalledTimes(1)
    }
  })
})
