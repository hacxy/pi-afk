import type { Issue } from '../src/issues.js'

import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runAfk } from '../src/loop.js'

vi.mock('../src/install.js', () => ({ installDeps: vi.fn() }))
vi.mock('../src/executor.js', () => ({ HostExecutor: vi.fn(), SandboxExecutor: vi.fn() }))
vi.mock('../src/sandbox.js', () => ({ requireSandboxImage: vi.fn() }))
vi.mock('../src/git.js', () => ({
  archiveWorktree: vi.fn(),
  branchName: vi.fn(),
  conflictedFiles: vi.fn(),
  createWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  fetchBase: vi.fn(),
  hasRemoteBranch: vi.fn(),
  mergeBaseIntoBranch: vi.fn(),
  pushBranch: vi.fn(),
  removeWorktree: vi.fn(),
}))
vi.mock('../src/issues.js', () => ({
  addComment: vi.fn(),
  addLabel: vi.fn(),
  ensureLabels: vi.fn(),
  listTodoIssues: vi.fn(),
  mergePr: vi.fn(),
  openPr: vi.fn(),
  prComment: vi.fn(),
  removeLabel: vi.fn(),
  repoName: vi.fn(),
  waitForChecksPass: vi.fn(),
}))
vi.mock('../src/log.js', () => ({ beginIssueLog: vi.fn(), log: vi.fn(), logError: vi.fn() }))

import { DEFAULT_CONFIG, type Config } from '../src/config.js'
import { HostExecutor, SandboxExecutor } from '../src/executor.js'
import {
  archiveWorktree,
  branchName,
  conflictedFiles,
  createWorktree,
  deleteBranch,
  fetchBase,
  hasRemoteBranch,
  mergeBaseIntoBranch,
  pushBranch,
  removeWorktree,
} from '../src/git.js'
import { installDeps } from '../src/install.js'
import {
  addComment,
  addLabel,
  ensureLabels,
  listTodoIssues,
  mergePr,
  openPr,
  prComment,
  removeLabel,
  repoName,
  waitForChecksPass,
} from '../src/issues.js'
import { beginIssueLog, log, logError } from '../src/log.js'
import { requireSandboxImage } from '../src/sandbox.js'

const issue: Issue = {
  number: 52,
  title: '网站链接导航去背景色',
  body: '导航链接有背景色，需要去掉。',
  labels: ['agent:todo'],
}

/** 宿主后端测试配置：显式关沙箱（沙箱接线在下方专门 describe） */
const cfg: Config = { ...DEFAULT_CONFIG, sandbox: false }
/** 沙箱后端测试配置：默认开启 */
const sandboxCfg: Config = { ...DEFAULT_CONFIG, baseBranch: 'main' }

const BASE_SHA = '1db529b480283a4d1c8d1bc9422962fbe950492e'

/** reviewer 默认通过 verdict：对所有阶段（implementer/fixer/merger）的 stdout 无害 */
const APPROVE = '<verdict>approve</verdict>'

function okResult(overrides: { stdout?: string; exitCode?: number; stderr?: string } = {}): {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  sessionFile: string
} {
  return {
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? APPROVE,
    stderr: overrides.stderr ?? '',
    timedOut: false,
    sessionFile: '/tmp/s.jsonl',
  }
}

interface FakeExecutor {
  runStage: ReturnType<typeof vi.fn>
}

/** HostExecutor mock 实际创建的实例（按创建顺序），断言用 */
let executors: FakeExecutor[] = []
/** 各阶段结果队列：每次 runStage shift 一个，耗尽回退 okResult() */
let stageQueue: Array<Parameters<typeof okResult>[0]> = []
/** SandboxExecutor 最近一次构造参数（worktree/imageTag 断言用） */
let lastSandboxOpts: { worktree?: string; imageTag?: string } = {}

beforeEach(() => {
  vi.clearAllMocks()
  executors = []
  stageQueue = []
  vi.mocked(ensureLabels).mockResolvedValue({ created: [], failed: [] })
  vi.mocked(listTodoIssues).mockReturnValue([issue])
  vi.mocked(branchName).mockReturnValue('afk/issue-52')
  vi.mocked(fetchBase).mockResolvedValue(BASE_SHA)
  vi.mocked(createWorktree).mockReturnValue('/tmp/wt')
  vi.mocked(repoName).mockReturnValue('hacxy/pi-afk')
  vi.mocked(archiveWorktree).mockReturnValue('.pi/afk/failed/afk/issue-52')
  vi.mocked(beginIssueLog).mockImplementation((n) => ({
    log: vi.fn(),
    logError: vi.fn(),
    logAgent: vi.fn(),
    flushAgent: vi.fn(),
    file: resolve(`.pi/afk/logs/issue-${n}.log`),
  }))
  vi.mocked(openPr).mockReturnValue({
    number: 100,
    url: 'https://github.com/hacxy/pi-afk/pull/100',
  })
  vi.mocked(installDeps).mockResolvedValue(undefined)
  vi.mocked(hasRemoteBranch).mockResolvedValue(false)
  vi.mocked(requireSandboxImage).mockResolvedValue('afk-sandbox-1234')
  vi.mocked(SandboxExecutor).mockImplementation(((config, opts) => {
    lastSandboxOpts = (opts ?? {}) as { worktree?: string; imageTag?: string }
    const executor: FakeExecutor = {
      runStage: vi.fn().mockImplementation(() => {
        const next = stageQueue.shift()
        return Promise.resolve(okResult(next))
      }),
    }
    executors.push(executor)
    return executor as unknown as InstanceType<typeof SandboxExecutor>
  }) as unknown as typeof SandboxExecutor)
  vi.mocked(mergeBaseIntoBranch).mockResolvedValue(true)
  vi.mocked(conflictedFiles).mockResolvedValue([])
  vi.mocked(mergePr).mockResolvedValue(undefined)
  vi.mocked(waitForChecksPass).mockResolvedValue('pass')
  vi.mocked(HostExecutor).mockImplementation(() => {
    const executor: FakeExecutor = {
      runStage: vi.fn().mockImplementation(() => {
        const next = stageQueue.shift()
        return Promise.resolve(okResult(next))
      }),
    }
    executors.push(executor)
    return executor as unknown as InstanceType<typeof HostExecutor>
  })
})

/** 各 HostExecutor 实例的所有 runStage 调用：ctx 数组 */
function stageCalls(): Array<{ stage: string; cwd: string; prompt: string; model: string }> {
  return executors.flatMap((e) =>
    vi.mocked(e.runStage).mock.calls.map(([ctx]) => ({
      stage: ctx.stage,
      cwd: ctx.cwd ?? '',
      prompt: ctx.prompt,
      model: ctx.model,
    })),
  )
}

describe('runAfk 完整 pipeline（宿主后端，autoMerge=false 默认）', () => {
  it('成功：implementer → push → 开 PR → reviewer approve → done，不 merge', async () => {
    const results = await runAfk(cfg)
    expect(results[0].status).toBe('done')

    // 基线每迭代只 fetch 一次（串行），批内不再各自 fetch；sha 传入 worktree 创建
    expect(fetchBase).toHaveBeenCalledTimes(1)
    expect(createWorktree).toHaveBeenCalledWith(cfg, 'afk/issue-52', BASE_SHA)

    // 宿主侧装依赖，在 worktree 里执行
    expect(installDeps).toHaveBeenCalledTimes(1)
    expect(installDeps).toHaveBeenCalledWith('/tmp/wt', cfg, expect.any(Function), {
      imageTag: undefined, // 宿主模式不传镜像 tag
    })

    // 两阶段：implementer（新会话）+ reviewer-1（新会话，同一 worktree）
    const calls = stageCalls()
    expect(calls.map((c) => c.stage)).toEqual(['implementer', 'reviewer-1'])
    expect(calls.every((c) => c.cwd === '/tmp/wt')).toBe(true)
    expect(calls[0].prompt).toContain('#52')

    // 宿主 push（无远端残留 → 非 force）
    expect(pushBranch).toHaveBeenCalledWith('/tmp/wt', 'afk/issue-52', { force: false })
    expect(hasRemoteBranch).toHaveBeenCalledWith('afk/issue-52')

    // 开 PR：Closes #N + base 基线分支
    expect(openPr).toHaveBeenCalledTimes(1)
    const prOpts = vi.mocked(openPr).mock.calls[0][0]
    expect(prOpts.branch).toBe('afk/issue-52')
    expect(prOpts.base).toBe('main')
    expect(prOpts.body).toContain('Closes #52')

    // autoMerge=false：不 merge、不打 merged label
    expect(mergePr).not.toHaveBeenCalled()
    expect(addLabel).not.toHaveBeenCalledWith(52, 'agent:merged')

    // label 状态机 todo → done
    expect(addLabel).toHaveBeenCalledWith(52, 'agent:done')
    expect(removeLabel).toHaveBeenCalledWith(52, 'agent:todo')

    // 成功回报：分支 + PR + compare + review 轮数 + 待人工 merge
    expect(addComment).toHaveBeenCalledTimes(1)
    const body = vi.mocked(addComment).mock.calls[0][1]
    expect(body).toContain('afk/issue-52')
    expect(body).toContain('https://github.com/hacxy/pi-afk/pull/100')
    expect(body).toContain('https://github.com/hacxy/pi-afk/compare/main...afk/issue-52')
    expect(body).toContain('review：1 轮通过')
    expect(body).toContain('待人工 merge')

    // 成功清理：删 worktree + 删本地分支（远程分支留给 PR）
    expect(removeWorktree).toHaveBeenCalledWith('/tmp/wt')
    expect(deleteBranch).toHaveBeenCalledWith('afk/issue-52')
    expect(archiveWorktree).not.toHaveBeenCalled()
  })

  it('重跑场景：远端已有残留分支 → force-with-lease 覆盖（Q7）', async () => {
    vi.mocked(hasRemoteBranch).mockResolvedValue(true)

    const results = await runAfk(cfg)
    expect(results[0].status).toBe('done')
    expect(pushBranch).toHaveBeenCalledWith('/tmp/wt', 'afk/issue-52', { force: true })
  })

  it('review 不通过 → 反馈发 PR comment → fixer 修复 → 复审 approve → done', async () => {
    stageQueue.push(
      { exitCode: 0, stdout: APPROVE }, // implementer
      {
        // reviewer-1：request-changes + 问题清单
        exitCode: 0,
        stdout:
          '<verdict>request-changes</verdict>\n\n1. src/a.ts: 空指针风险\n2. src/b.ts: 缺测试',
      },
      { exitCode: 0, stdout: APPROVE }, // fixer-1
      { exitCode: 0, stdout: APPROVE }, // reviewer-2：通过
    )

    const results = await runAfk(cfg)
    expect(results[0].status).toBe('done')

    const stages = stageCalls().map((c) => c.stage)
    expect(stages).toEqual(['implementer', 'reviewer-1', 'fixer-1', 'reviewer-2'])

    // review 反馈发 PR comment（PR 编号 ≠ issue 编号，含问题清单）
    expect(prComment).toHaveBeenCalledTimes(1)
    expect(prComment).toHaveBeenCalledWith(100, expect.stringContaining('第 1 轮'))
    const reviewBody = vi.mocked(prComment).mock.calls[0][1]
    expect(reviewBody).toContain('第 1 轮')
    expect(reviewBody).toContain('空指针风险')

    // fixer 后宿主 push（非 force）
    expect(pushBranch).toHaveBeenCalledWith('/tmp/wt', 'afk/issue-52')
  })

  it('review 轮数耗尽仍不通过 → 失败（failed label + 归档 + 失败回报 stage reviewer）', async () => {
    stageQueue.push(
      { exitCode: 0, stdout: APPROVE }, // implementer
      { exitCode: 0, stdout: '<verdict>request-changes</verdict>\n\n1. 问题A' }, // reviewer-1
      { exitCode: 0, stdout: APPROVE }, // fixer-1
      { exitCode: 0, stdout: '<verdict>request-changes</verdict>\n\n1. 问题B' }, // reviewer-2
    )

    const results = await runAfk(cfg)
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('review 第 2 轮仍未通过')

    // 走到失败路径：归档 + 删本地分支 + 失败 comment + failed label
    expect(archiveWorktree).toHaveBeenCalledWith(cfg, '/tmp/wt', 'afk/issue-52')
    expect(deleteBranch).toHaveBeenCalledWith('afk/issue-52')
    expect(addLabel).toHaveBeenCalledWith(52, 'agent:failed')
    expect(removeLabel).toHaveBeenCalledWith(52, 'agent:todo')
    // 失败 comment 含阶段 review（不是 implementer）
    expect(vi.mocked(addComment).mock.calls[0][1]).toContain('review')
  })

  it('reviewer 阶段 pi 非零退出 → StageFailure(reviewer) 失败', async () => {
    stageQueue.push(
      { exitCode: 0, stdout: APPROVE }, // implementer
      { exitCode: 1, stderr: 'reviewer 崩溃' }, // reviewer-1
    )

    const results = await runAfk(cfg)
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('reviewer 退出码 1')
  })

  it('reviewer 输出无 verdict → 按 request-changes 保守处理（原文进修复轮）', async () => {
    stageQueue.push(
      { exitCode: 0, stdout: APPROVE }, // implementer
      { exitCode: 0, stdout: '我觉得这里有点问题，但没说格式' }, // reviewer-1（无 verdict 块）
      { exitCode: 0, stdout: APPROVE }, // fixer-1
      { exitCode: 0, stdout: APPROVE }, // reviewer-2
    )

    const results = await runAfk(cfg)
    expect(results[0].status).toBe('done')
    const stages = stageCalls().map((c) => c.stage)
    expect(stages).toEqual(['implementer', 'reviewer-1', 'fixer-1', 'reviewer-2'])
  })

  it('失败（implementer 非零退出）：归档 + 删本地分支 + 失败 comment + failed label，不 push 不开 PR', async () => {
    stageQueue.push({ exitCode: 1, stderr: 'typecheck 失败' })

    const results = await runAfk(cfg)
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('implementer 退出码 1')

    expect(pushBranch).not.toHaveBeenCalled()
    expect(openPr).not.toHaveBeenCalled()

    expect(archiveWorktree).toHaveBeenCalledWith(cfg, '/tmp/wt', 'afk/issue-52')
    expect(deleteBranch).toHaveBeenCalledWith('afk/issue-52')
    expect(removeWorktree).not.toHaveBeenCalled() // 已归档，不再 remove

    expect(addComment).toHaveBeenCalledTimes(1)
    const body = vi.mocked(addComment).mock.calls[0][1]
    expect(body).toContain('implementer')
    expect(body).toContain('退出码：1')
    expect(body).toContain('typecheck 失败')
    expect(body).toContain('agent:todo')

    expect(addLabel).toHaveBeenCalledWith(52, 'agent:failed')
    expect(removeLabel).toHaveBeenCalledWith(52, 'agent:todo')
  })

  it('依赖安装失败 → 归档 + 删分支 + 失败 comment（阶段 install），不跑任何阶段', async () => {
    vi.mocked(installDeps).mockRejectedValue(new Error('依赖安装失败（1）'))

    const results = await runAfk(cfg)
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('依赖安装失败')
    expect(executors).toHaveLength(0)
    expect(pushBranch).not.toHaveBeenCalled()
    expect(openPr).not.toHaveBeenCalled()
    expect(vi.mocked(addComment).mock.calls[0][1]).toContain('install')
    expect(addLabel).toHaveBeenCalledWith(52, 'agent:failed')
  })
})

describe('runAfk 启动 ensureLabels（幂等补建状态机 label）', () => {
  it('启动时调用一次，成功补建后打印已建列表并继续', async () => {
    vi.mocked(ensureLabels).mockResolvedValue({
      created: ['agent:failed', 'agent:merged'],
      failed: [],
    })
    vi.mocked(listTodoIssues).mockReturnValue([]) // 无待处理 → 流程自然结束

    const results = await runAfk(cfg)
    expect(ensureLabels).toHaveBeenCalledWith(cfg)
    expect(results).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('agent:failed'))
  })

  it('todo label 创建失败 → 硬失败：不拉 issue、不跑任何阶段', async () => {
    vi.mocked(ensureLabels).mockResolvedValue({
      created: [],
      failed: [{ name: 'agent:todo', error: 'gh: not found' }],
    })

    await expect(runAfk(cfg)).rejects.toThrow(/agent:todo/)
    expect(listTodoIssues).not.toHaveBeenCalled()
    expect(executors).toHaveLength(0)
  })

  it('非 todo label 创建失败 → logError 警告后继续跑', async () => {
    vi.mocked(ensureLabels).mockResolvedValue({
      created: [],
      failed: [{ name: 'agent:merged', error: 'permission denied' }],
    })

    const results = await runAfk(cfg)
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('agent:merged'))
    // 主流程照常：拉 issue 并处理
    expect(listTodoIssues).toHaveBeenCalledTimes(1)
    expect(results[0].status).toBe('done')
  })

  it('拉取 label 列表本身失败 → 直接抛错', async () => {
    vi.mocked(ensureLabels).mockRejectedValue(new Error('拉取 label 列表失败：gh down'))

    await expect(runAfk(cfg)).rejects.toThrow(/拉取 label 列表失败/)
  })
})

describe('runAfk autoMerge=true：合并 + 冲突化解', () => {
  const mergeCfg: Config = { ...cfg, autoMerge: true }

  it('成功：review 通过 → 串行合并（fetch 最新 base → 干净 merge → push → 等 checks → squash merge）→ merged + done label', async () => {
    const results = await runAfk(mergeCfg)
    expect(results[0].status).toBe('done')

    // 合并阶段：锁内再 fetch 一次最新 base（迭代层一次 + 合并一次）
    expect(fetchBase).toHaveBeenCalledTimes(2)
    expect(mergeBaseIntoBranch).toHaveBeenCalledWith('/tmp/wt', 'afk/issue-52', 'main')
    expect(waitForChecksPass).toHaveBeenCalledWith(100, 600)
    expect(mergePr).toHaveBeenCalledWith(100)

    // merged label + done label
    expect(addLabel).toHaveBeenCalledWith(52, 'agent:merged')
    expect(addLabel).toHaveBeenCalledWith(52, 'agent:done')

    // 成功回报标记已合并
    const body = vi.mocked(addComment).mock.calls[0][1]
    expect(body).toContain('已合并')
  })

  it('合并冲突 → merger agent 化解（同一 worktree 新会话）→ push → 合并成功', async () => {
    vi.mocked(mergeBaseIntoBranch).mockResolvedValueOnce(false) // 第一次 sync 冲突
    vi.mocked(conflictedFiles).mockResolvedValueOnce(['src/a.ts'])
    stageQueue.push({ exitCode: 0, stdout: APPROVE }) // implementer

    const results = await runAfk(mergeCfg)
    expect(results[0].status).toBe('done')

    // merger-1 阶段：cwd=worktree，prompt 含冲突文件
    const merger = stageCalls().find((c) => c.stage === 'merger-1')
    expect(merger).toBeDefined()
    expect(merger?.cwd).toBe('/tmp/wt')
    expect(merger?.prompt).toContain('src/a.ts')
    expect(merger?.prompt).toContain('main')
    expect(mergePr).toHaveBeenCalledTimes(1)
    expect(addLabel).toHaveBeenCalledWith(52, 'agent:merged')
  })

  it('merge 失败 → 重新同步 base → 第二次尝试成功', async () => {
    vi.mocked(mergePr).mockRejectedValueOnce(new Error('merge 有冲突'))
    stageQueue.push({ exitCode: 0, stdout: APPROVE }) // implementer

    const results = await runAfk(mergeCfg)
    expect(results[0].status).toBe('done')
    expect(mergeBaseIntoBranch).toHaveBeenCalledTimes(2) // 两次 sync
    expect(mergePr).toHaveBeenCalledTimes(2)
  })

  it('conflictTries 耗尽仍合并失败 → issue 失败（failed label，PR/远端保留）', async () => {
    vi.mocked(mergePr).mockRejectedValue(new Error('merge 一直失败'))
    stageQueue.push({ exitCode: 0, stdout: APPROVE }) // implementer

    const results = await runAfk(mergeCfg)
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('合并失败')
    expect(mergePr).toHaveBeenCalledTimes(2) // conflictTries=2
    expect(addLabel).toHaveBeenCalledWith(52, 'agent:failed')
    expect(addLabel).not.toHaveBeenCalledWith(52, 'agent:merged')
  })

  it('checks 失败 → 合并中止 → issue 失败', async () => {
    vi.mocked(waitForChecksPass).mockResolvedValue('fail')
    stageQueue.push({ exitCode: 0, stdout: APPROVE }) // implementer

    const results = await runAfk(mergeCfg)
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('checks 失败')
    expect(mergePr).not.toHaveBeenCalled()
  })

  it('waitForChecks=false：不等 checks 直接合并', async () => {
    const noWait: Config = { ...mergeCfg, waitForChecks: false }
    stageQueue.push({ exitCode: 0, stdout: APPROVE }) // implementer

    const results = await runAfk(noWait)
    expect(results[0].status).toBe('done')
    expect(waitForChecksPass).not.toHaveBeenCalled()
    expect(mergePr).toHaveBeenCalledWith(100)
  })

  it('批内并发 issue 的合并阶段串行（MergeQueue 一次一个，不并发 merge）', async () => {
    const issue2: Issue = { ...issue, number: 53, title: '另一件事' }
    vi.mocked(listTodoIssues).mockReturnValue([issue, issue2])
    vi.mocked(branchName).mockImplementation((_c, i) => `afk/issue-${i.number}`)
    vi.mocked(createWorktree).mockImplementation((_c, branch) => `/tmp/wt-${branch.split('-')[2]}`)

    // mergePr 内部探测并发：同时活跃数 > 1 即失败
    let active = 0
    let maxActive = 0
    vi.mocked(mergePr).mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active -= 1
    })

    const results = await runAfk(mergeCfg)
    expect(results.every((r) => r.status === 'done')).toBe(true)
    expect(mergePr).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1) // 串行：从不并发
  })
})

describe('runAfk 迭代语义', () => {
  it('maxIterations 默认 1：一次迭代 = 并发处理至多 maxParallel 个 issue', async () => {
    const issue2: Issue = { ...issue, number: 53, title: '另一件事' }
    vi.mocked(listTodoIssues).mockReturnValue([issue, issue2])
    vi.mocked(branchName).mockImplementation((_c, i) =>
      i.number === 52 ? 'afk/issue-52' : 'afk/issue-53',
    )

    const results = await runAfk(cfg)

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === 'done')).toBe(true)
    expect(listTodoIssues).toHaveBeenCalledTimes(1)
    expect(openPr).toHaveBeenCalledTimes(2)
    // 每 issue 两个 HostExecutor 实例（implementer + reviewer-1）；并发下交错顺序不保证，断言构成
    expect(executors).toHaveLength(4)
    expect(
      stageCalls()
        .map((c) => c.stage)
        .sort(),
    ).toEqual(['implementer', 'implementer', 'reviewer-1', 'reviewer-1'])
  })

  it('maxIterations=3、maxParallel=2：三次迭代，每批至多 2 个，批间重拉', async () => {
    const issues = [
      { ...issue, number: 52, title: '甲' },
      { ...issue, number: 53, title: '乙' },
      { ...issue, number: 54, title: '丙' },
    ]
    vi.mocked(listTodoIssues)
      .mockReturnValueOnce(issues)
      .mockReturnValueOnce(issues)
      .mockReturnValue([]) // 第三批已无待办（label 翻转后）
    vi.mocked(branchName).mockImplementation((_c, i) => `afk/issue-${i.number}`)

    const results = await runAfk(cfg, 3)

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.status === 'done')).toBe(true)
    expect(fetchBase).toHaveBeenCalledTimes(2) // 前两迭代各 fetch 一次；第三迭代无待办 break
    expect(listTodoIssues).toHaveBeenCalledTimes(3)
    expect(openPr).toHaveBeenCalledTimes(3)
  })

  it('label 翻转失败兜底：seen 防同批重选死循环，提前结束', async () => {
    vi.mocked(listTodoIssues).mockReturnValue([issue]) // 永远返回同一个（label 没翻转）

    const results = await runAfk(cfg, 5)

    expect(results).toHaveLength(1)
    expect(listTodoIssues).toHaveBeenCalledTimes(2) // 第二次拉到 seen 内 → 终止
    expect(openPr).toHaveBeenCalledTimes(1)
  })

  it('fetch 基线失败：中止本轮，不建 worktree、不跑 implementer、不开 PR', async () => {
    vi.mocked(fetchBase).mockRejectedValue(new Error('fetch origin main 失败'))

    const results = await runAfk(cfg)

    expect(results).toHaveLength(0)
    expect(createWorktree).not.toHaveBeenCalled()
    expect(executors).toHaveLength(0)
    expect(openPr).not.toHaveBeenCalled()
  })
})

describe('runAfk 沙箱接线（sandbox=true 默认模式）', () => {
  it('启动先 requireSandboxImage 校验镜像，阶段跑在 SandboxExecutor（worktree+imageTag），install 容器内执行', async () => {
    const results = await runAfk(sandboxCfg)

    expect(requireSandboxImage).toHaveBeenCalledWith(process.cwd())
    expect(results[0].status).toBe('done')
    expect(executors.length).toBeGreaterThan(0) // 阶段真实跑了
    expect(HostExecutor).not.toHaveBeenCalled() // 默认模式不用宿主后端
    expect(lastSandboxOpts).toMatchObject({ worktree: '/tmp/wt', imageTag: 'afk-sandbox-1234' })
    // 依赖安装在容器内执行（imageTag 下行到 installDeps）
    expect(installDeps).toHaveBeenCalledWith('/tmp/wt', sandboxCfg, expect.anything(), {
      imageTag: 'afk-sandbox-1234',
    })
  })

  it('requireSandboxImage 失败（未构建镜像 / docker 不可用）→ runAfk 直接抛错：不拉 issue、不建 worktree、不跑任何阶段', async () => {
    vi.mocked(requireSandboxImage).mockRejectedValue(
      new Error('沙箱镜像未构建（afk-sandbox-xxx）：请执行 afk init 构建'),
    )

    await expect(runAfk(sandboxCfg)).rejects.toThrow(/afk init/)

    expect(listTodoIssues).not.toHaveBeenCalled()
    expect(beginIssueLog).not.toHaveBeenCalled()
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('sandbox=false（--local 的持久化形态）→ 不校验镜像、跑 HostExecutor、install 不带 imageTag', async () => {
    const results = await runAfk(cfg)

    expect(requireSandboxImage).not.toHaveBeenCalled()
    expect(SandboxExecutor).not.toHaveBeenCalled()
    expect(HostExecutor).toHaveBeenCalled()
    expect(installDeps).toHaveBeenCalledWith('/tmp/wt', cfg, expect.anything(), {
      imageTag: undefined,
    })
    expect(results[0].status).toBe('done')
  })
})
