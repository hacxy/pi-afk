import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

import { spawn } from 'node:child_process'

import { installCommand, installDeps } from '../src/install.js'

function fakeChild(): EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  return child
}

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
  it('成功：在 worktree cwd spawn install，CI=true，exit 0 → resolve', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'afk-install-'))
    writeFileSync(join(wt, 'pnpm-lock.yaml'), '')
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)

    const promise = installDeps(wt)
    await new Promise((r) => setImmediate(r))

    expect(spawn).toHaveBeenCalledWith(
      'pnpm',
      ['install', '--frozen-lockfile'],
      expect.objectContaining({
        cwd: wt,
        env: expect.objectContaining({ CI: 'true' }),
      }),
    )
    child.emit('exit', 0, null)
    await expect(promise).resolves.toBeUndefined()
  })

  it('失败：exit 非 0 → reject（带退出码与 stderr 摘要）', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'afk-install-'))
    writeFileSync(join(wt, 'pnpm-lock.yaml'), '')
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)

    const promise = installDeps(wt)
    await new Promise((r) => setImmediate(r))
    child.stderr.write('ERR! 依赖解析失败')
    child.emit('exit', 1, null)
    await expect(promise).rejects.toThrow(/依赖安装失败（1）/)
  })
})
