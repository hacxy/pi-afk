import { execa } from 'execa'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/index.js', () => ({ runAfk: vi.fn() }))
vi.mock('../src/log.js', () => ({ log: vi.fn(), logError: vi.fn() }))

import { runAfkLoop } from '../src/cli.js'
import { runAfk } from '../src/index.js'
import { log, logError } from '../src/log.js'

const issue = (number: number, title: string) => ({ number, title, body: 'body', labels: [] })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runAfkLoop（默认命令 action）', () => {
  it('全部成功 → 汇总 + exitCode 0', async () => {
    vi.mocked(runAfk).mockResolvedValue([
      { issue: issue(1, '甲'), status: 'done' },
      { issue: issue(2, '乙'), status: 'done' },
    ])

    await runAfkLoop()

    expect(log).toHaveBeenCalledWith(expect.stringContaining('2/2 成功'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('#1 甲'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('#2 乙'))
    expect(logError).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(0)
  })

  it('有失败 → 汇总列出失败 + exitCode 1', async () => {
    vi.mocked(runAfk).mockResolvedValue([
      { issue: issue(1, '甲'), status: 'done' },
      { issue: issue(3, '丙'), status: 'failed', error: 'implementer 退出码 1' },
    ])

    await runAfkLoop()

    expect(log).toHaveBeenCalledWith(expect.stringContaining('1/2 成功'))
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('#3 丙'))
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('implementer 退出码 1'))
    expect(process.exitCode).toBe(1)
  })
})

describe('cac CLI 冒烟', () => {
  it('--help 输出用法且 exit 0', async () => {
    const { stdout, exitCode } = await execa('node', [
      '--import',
      'tsx',
      resolve('src/cli.ts'),
      '--help',
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('afk')
    expect(stdout).toContain('Usage')
  })

  it('--version 输出版本号且 exit 0', async () => {
    const { stdout, exitCode } = await execa('node', [
      '--import',
      'tsx',
      resolve('src/cli.ts'),
      '--version',
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('0.1.0')
  })
})
