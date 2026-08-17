import { execa } from 'execa'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_CONFIG } from '../src/config.js'
import {
  analyzeChecks,
  checksState,
  ensureLabels,
  mergePr,
  prMergeable,
  waitForChecksPass,
} from '../src/issues.js'

vi.mock('execa', () => ({ execa: vi.fn() }))

const mockExeca = vi.mocked(execa)

beforeEach(() => {
  vi.clearAllMocks()
  mockExeca.mockResolvedValue({ stdout: '' })
})

describe('analyzeChecks（纯函数）', () => {
  it('空 rollup → none（无 CI）', () => {
    expect(analyzeChecks([])).toBe('none')
  })

  it('全部 COMPLETED + 成功结论 → pass', () => {
    expect(
      analyzeChecks([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { status: 'COMPLETED', conclusion: 'SKIPPED' },
      ]),
    ).toBe('pass')
  })

  it('任一失败结论 → fail', () => {
    for (const conclusion of [
      'FAILURE',
      'CANCELLED',
      'TIMED_OUT',
      'ACTION_REQUIRED',
      'STARTUP_FAILURE',
    ]) {
      expect(analyzeChecks([{ status: 'COMPLETED', conclusion }])).toBe('fail')
    }
  })

  it('存在进行中 → pending', () => {
    expect(analyzeChecks([{ status: 'IN_PROGRESS' }])).toBe('pending')
    expect(analyzeChecks([{ status: 'QUEUED' }])).toBe('pending')
    expect(
      analyzeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'PENDING' }]),
    ).toBe('pending')
  })
})

describe('checksState（gh pr view statusCheckRollup）', () => {
  it('解析 gh 输出 JSON → pass', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]),
    })
    await expect(checksState(12)).resolves.toBe('pass')
  })

  it('空输出 → none', async () => {
    mockExeca.mockResolvedValue({ stdout: '' })
    await expect(checksState(12)).resolves.toBe('none')
  })

  it('坏 JSON → pending（由超时兜底）', async () => {
    mockExeca.mockResolvedValue({ stdout: 'not json' })
    await expect(checksState(12)).resolves.toBe('pending')
  })
})

describe('waitForChecksPass（轮询）', () => {
  it('pending → 轮询 → pass', async () => {
    mockExeca
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ status: 'IN_PROGRESS' }]) }) // pending
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]),
      })
    await expect(waitForChecksPass(12, 60, 1)).resolves.toBe('pass')
  })

  it('fail → 立即返回 fail 不轮询', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify([{ status: 'COMPLETED', conclusion: 'FAILURE' }]),
    })
    await expect(waitForChecksPass(12, 60, 1)).resolves.toBe('fail')
    expect(mockExeca).toHaveBeenCalledTimes(1)
  })

  it('none（无 CI）→ 直接 pass', async () => {
    mockExeca.mockResolvedValue({ stdout: '' })
    await expect(waitForChecksPass(12, 60, 1)).resolves.toBe('pass')
  })

  it('持续 pending 超时 → timeout', async () => {
    mockExeca.mockResolvedValue({ stdout: JSON.stringify([{ status: 'IN_PROGRESS' }]) })
    await expect(waitForChecksPass(12, 0, 1)).resolves.toBe('timeout')
  })
})

describe('mergePr / prMergeable', () => {
  it('mergePr：gh pr merge --squash --delete-branch', async () => {
    await mergePr(12)
    expect(mockExeca).toHaveBeenCalledWith('gh', [
      'pr',
      'merge',
      '12',
      '--squash',
      '--delete-branch',
    ])
  })

  it('prMergeable 解析 MERGEABLE / CONFLICTING / 未知回落 UNKNOWN', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'MERGEABLE' })
    await expect(prMergeable(12)).resolves.toBe('MERGEABLE')

    mockExeca.mockResolvedValueOnce({ stdout: 'CONFLICTING' })
    await expect(prMergeable(12)).resolves.toBe('CONFLICTING')

    mockExeca.mockResolvedValueOnce({ stdout: 'garbage' })
    await expect(prMergeable(12)).resolves.toBe('UNKNOWN')
  })
})

describe('ensureLabels（幂等补建）', () => {
  it('全缺 → 建 4 个（语义色 + 描述），created 返回全部', async () => {
    mockExeca.mockResolvedValue({ stdout: '' }) // list 空 → 全缺
    await expect(ensureLabels(DEFAULT_CONFIG)).resolves.toEqual({
      created: ['agent:todo', 'agent:done', 'agent:failed', 'agent:merged'],
      failed: [],
    })

    const creates = mockExeca.mock.calls.filter(
      (call) => call[1][0] === 'label' && call[1][1] === 'create',
    )
    expect(creates).toHaveLength(4)
    // 首建 todo：带语义色与描述
    expect(mockExeca).toHaveBeenCalledWith('gh', [
      'label',
      'create',
      'agent:todo',
      '--color',
      '#FBCA04',
      '--description',
      'afk: queued for work',
    ])
  })

  it('已存在部分 → 只补缺失，不重建已有（尊重用户自定义）', async () => {
    mockExeca.mockResolvedValue({ stdout: 'agent:todo\nagent:done\n' })
    await expect(ensureLabels(DEFAULT_CONFIG)).resolves.toEqual({
      created: ['agent:failed', 'agent:merged'],
      failed: [],
    })
    expect(mockExeca).toHaveBeenCalledTimes(1 + 2) // 1 次 list + 2 次 create
  })

  it('单个 create 失败 → 收集进 failed，不中断其余', async () => {
    mockExeca
      .mockResolvedValueOnce({ stdout: '' }) // list
      .mockRejectedValueOnce(new Error('not found')) // todo create 失败
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' })
    await expect(ensureLabels(DEFAULT_CONFIG)).resolves.toEqual({
      created: ['agent:done', 'agent:failed', 'agent:merged'],
      failed: [{ name: 'agent:todo', error: 'not found' }],
    })
  })

  it('拉取 label 列表失败 → 直接抛错（无法判断缺失，不盲目建）', async () => {
    mockExeca.mockRejectedValue(new Error('gh: not a git repository'))
    await expect(ensureLabels(DEFAULT_CONFIG)).rejects.toThrow(/拉取 label 列表失败/)
  })

  it('使用配置化的 label 名（AFK_* / config.json 可定制）', async () => {
    mockExeca.mockResolvedValue({ stdout: '' })
    await ensureLabels({ ...DEFAULT_CONFIG, todoLabel: 'queue', doneLabel: 'ship' })
    expect(mockExeca).toHaveBeenCalledWith('gh', [
      'label',
      'create',
      'queue',
      '--color',
      '#FBCA04',
      '--description',
      'afk: queued for work',
    ])
    expect(mockExeca).toHaveBeenCalledWith('gh', [
      'label',
      'create',
      'ship',
      '--color',
      '#0E8A16',
      '--description',
      'afk: completed',
    ])
  })
})
