import type { Issue } from '../src/issues.js'
import type { Sandbox } from '../src/sandbox.js'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runAfk } from '../src/loop.js'

vi.mock('../src/sandbox.js', () => ({ createSandbox: vi.fn() }))
vi.mock('../src/git.js', () => ({
  branchName: vi.fn(),
  createWorktree: vi.fn(),
  pushBranch: vi.fn(),
  removeWorktree: vi.fn(),
}))
vi.mock('../src/issues.js', () => ({
  listTodoIssues: vi.fn(),
  addLabel: vi.fn(),
  removeLabel: vi.fn(),
}))
vi.mock('../src/log.js', () => ({ log: vi.fn(), logError: vi.fn() }))

import { branchName, createWorktree, pushBranch, removeWorktree } from '../src/git.js'
import { addLabel, listTodoIssues, removeLabel } from '../src/issues.js'
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
  it('成功：每 issue 一个容器，装依赖一次，三阶段复用同一容器，push + done label + 销毁', async () => {
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
  })

  it('失败（implementer 非零退出）：不 push、failed label、容器仍销毁', async () => {
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
    expect(addLabel).toHaveBeenCalledWith(52, 'agent:failed')
    expect(removeLabel).toHaveBeenCalledWith(52, 'agent:todo')
    expect(sandbox.destroy).toHaveBeenCalledTimes(1) // 失败也销毁，无孤儿容器
    expect(removeWorktree).toHaveBeenCalledWith('/tmp/wt')
  })

  it('planner zod 校验非法重试 3 次仍失败 → failed，容器销毁', async () => {
    const sandbox = makeSandbox()
    sandbox.runStage = vi.fn().mockResolvedValue(okResult('不是 JSON'))
    vi.mocked(createSandbox).mockResolvedValue(sandbox)

    const results = await runAfk()
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('planner 重试')

    const stages = vi.mocked(sandbox.runStage).mock.calls.map(([ctx]) => ctx.stage)
    expect(stages).toEqual(['planner', 'planner', 'planner']) // 上限 2 次重试 = 3 次尝试
    expect(pushBranch).not.toHaveBeenCalled()
    expect(sandbox.destroy).toHaveBeenCalledTimes(1)
  })

  it('依赖安装失败 → failed，不跑任何阶段，容器销毁', async () => {
    const sandbox = makeSandbox()
    sandbox.installDeps = vi.fn().mockRejectedValue(new Error('依赖安装失败（1）'))
    vi.mocked(createSandbox).mockResolvedValue(sandbox)

    const results = await runAfk()
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('依赖安装失败')
    expect(sandbox.runStage).not.toHaveBeenCalled()
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
