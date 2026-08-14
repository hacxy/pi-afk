import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'

import { installCommand, installDeps } from '../src/install.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('installCommand（lockfile 检测）', () => {
  it('pnpm → pnpm install --frozen-lockfile', () => {
    const wt = mkdtempSync(join(tmpdir(), 'afk-install-'))
    writeFileSync(join(wt, 'pnpm-lock.yaml'), '')
    expect(installCommand(wt)).toBe('pnpm install --frozen-lockfile')
  })

  it('npm → npm ci', () => {
    const wt = mkdtempSync(join(tmpdir(), 'afk-install-'))
    writeFileSync(join(wt, 'package-lock.json'), '')
    expect(installCommand(wt)).toBe('npm ci')
  })

  it('yarn → yarn install --immutable', () => {
    const wt = mkdtempSync(join(tmpdir(), 'afk-install-'))
    writeFileSync(join(wt, 'yarn.lock'), '')
    expect(installCommand(wt)).toBe('yarn install --immutable')
  })

  it('无 lockfile → 抛错（不确定安装方式宁可失败，不让 agent 自装）', () => {
    const wt = mkdtempSync(join(tmpdir(), 'afk-install-'))
    expect(() => installCommand(wt)).toThrow(/lockfile/)
  })
})

describe('installDeps（宿主侧安装）', () => {
  it('成功：在 worktree cwd 跑 install，CI=true，exit 0 → resolve', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'afk-install-'))
    writeFileSync(join(wt, 'pnpm-lock.yaml'), '')
    vi.mocked(execa).mockResolvedValue({ stdout: '', stderr: '' } as never)

    await expect(installDeps(wt)).resolves.toBeUndefined()

    expect(execa).toHaveBeenCalledWith(
      'pnpm',
      ['install', '--frozen-lockfile'],
      expect.objectContaining({
        cwd: wt,
        env: expect.objectContaining({ CI: 'true' }),
      }),
    )
  })

  it('失败：非零退出 → reject（带退出码与 stderr 摘要）', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'afk-install-'))
    writeFileSync(join(wt, 'pnpm-lock.yaml'), '')
    vi.mocked(execa).mockRejectedValue({ exitCode: 1, stderr: 'ERR! 依赖解析失败' })

    await expect(installDeps(wt)).rejects.toThrow(/依赖安装失败（1）/)
  })
})
