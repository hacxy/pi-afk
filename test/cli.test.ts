import { execa } from 'execa'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/index.js', () => ({ runAfk: vi.fn() }))
vi.mock('../src/log.js', () => ({ log: vi.fn(), logError: vi.fn() }))
vi.mock('../src/config.js', () => ({ loadConfig: vi.fn() }))
vi.mock('../src/init.js', () => ({ runInit: vi.fn() }))
vi.mock('../src/identity.js', () => ({
  createGitIdentityResolver: vi.fn(() => () => ({ name: 'hacxy', email: 'hacxy.js@outlook.com' })),
}))

import { runAfkLoop } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { createGitIdentityResolver } from '../src/identity.js'
import { runAfk } from '../src/index.js'
import { log, logError } from '../src/log.js'

const issue = (number: number, title: string) => ({ number, title, body: 'body', labels: [] })

/** 配置 fixture：全部键显式（不依赖 DEFAULT_CONFIG import，避免 mock 干扰） */
const cfg = {
  model: 'deepseek/deepseek-v4-flash',
  thinking: 'medium',
  maxParallel: 2,
  todoLabel: 'agent:todo',
  doneLabel: 'agent:done',
  failedLabel: 'agent:failed',
  branchPrefix: 'afk',
  baseBranch: 'main',
  worktreesDir: '.pi/afk/worktrees',
  failedDir: '.pi/afk/failed',
  logsDir: '.pi/afk/logs',
  sessionsDir: '.pi/afk/sessions',
  idleTimeoutSec: 600,
  completionTimeoutSec: 60,
}

beforeEach(() => {
  vi.clearAllMocks()
  process.exitCode = 0
  vi.mocked(loadConfig).mockReturnValue(cfg)
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

  it('maxIterations 透传：runAfkLoop(3) → runAfk(config, 3)', async () => {
    vi.mocked(runAfk).mockResolvedValue([])
    await runAfkLoop(3)
    expect(runAfk).toHaveBeenCalledWith(cfg, 3)
  })

  it('位置参数 clamp：0/负数/非数字/空串/缺省均按 1', async () => {
    vi.mocked(runAfk).mockResolvedValue([])
    await runAfkLoop('0')
    expect(runAfk).toHaveBeenCalledWith(cfg, 1)
    await runAfkLoop('-3')
    expect(runAfk).toHaveBeenCalledWith(cfg, 1)
    await runAfkLoop('abc')
    expect(runAfk).toHaveBeenCalledWith(cfg, 1)
    await runAfkLoop('')
    expect(runAfk).toHaveBeenCalledWith(cfg, 1)
    await runAfkLoop()
    expect(runAfk).toHaveBeenCalledWith(cfg, 1)
  })

  it('缺 config.json（loadConfig 抛错）→ logError 含 afk init 提示 + exit 1，不跑 loop', async () => {
    vi.mocked(loadConfig).mockImplementationOnce(() => {
      throw new Error('未找到配置 …\n请在项目根目录执行: afk init')
    })

    await runAfkLoop()

    expect(logError).toHaveBeenCalledWith(expect.stringContaining('afk init'))
    expect(process.exitCode).toBe(1)
    expect(runAfk).not.toHaveBeenCalled()
  })

  it('身份缺失 → 启动即拦：logError + exitCode 1，不跑 loop', async () => {
    vi.mocked(createGitIdentityResolver).mockImplementationOnce(() => {
      throw new Error(
        '无法确定 git 提交身份：请用任一方式设置——① git config --global user.name/user.email；② 环境变量 AFK_GIT_AUTHOR/AFK_GIT_EMAIL；③ config.json 的 gitAuthor/gitEmail',
      )
    })

    await runAfkLoop()

    expect(logError).toHaveBeenCalledWith(expect.stringContaining('无法确定 git 提交身份'))
    expect(process.exitCode).toBe(1)
    expect(runAfk).not.toHaveBeenCalled()
  })

  it('身份就绪 → 启动日志含提交身份', async () => {
    vi.mocked(runAfk).mockResolvedValue([])

    await runAfkLoop()

    expect(log).toHaveBeenCalledWith(expect.stringContaining('hacxy <hacxy.js@outlook.com>'))
  })
})

describe('cac CLI 冒烟', () => {
  it('--help 输出用法（含 init 命令）且 exit 0', async () => {
    const { stdout, exitCode } = await execa('node', [
      '--import',
      'tsx',
      resolve('src/cli.ts'),
      '--help',
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('afk')
    expect(stdout).toContain('Usage')
    expect(stdout).toContain('init')
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

  it('init 命令：在 git 仓库内生成 config.json 且 exit 0', async () => {
    const { execSync } = await import('node:child_process')
    const { mkdtempSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'afk-cli-init-'))
    execSync('git init -q', { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    // tsx 二进制与 cli 入口都用绝对路径（tmp cwd 下无法解析裸 'tsx' 包）
    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx')
    const cli = resolve('src/cli.ts')

    const stdout = execSync(`"${tsx}" "${cli}" init`, { cwd: dir, encoding: 'utf8' })

    expect(stdout).toContain('已生成配置')
    expect(existsSync(join(dir, '.pi', 'afk', 'config.json'))).toBe(true)
    execSync(`rm -rf "${dir}"`)
  })
})
