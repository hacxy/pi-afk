import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'

import { DEFAULT_CONFIG } from '../src/config.js'
import { installCommand, installDeps } from '../src/install.js'

/** 宿主模式测试配置：sandbox 关闭（DEFAULT_CONFIG 默认 sandbox=true） */
const cfg = { ...DEFAULT_CONFIG, sandbox: false }
/** 沙箱模式测试配置 + 已构建镜像 tag */
const sandboxCfg = { ...DEFAULT_CONFIG }
const IMAGE = 'afk-sandbox-0123456789abcdef'

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

    await expect(installDeps(wt, cfg)).resolves.toBeUndefined()

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

    await expect(installDeps(wt, cfg)).rejects.toThrow(/依赖安装失败（1）/)
  })
})

describe('installDeps（沙箱容器内安装）', () => {
  it('sandbox 开启 → docker run 容器内执行 install：挂载/--entrypoint sh/-w/镜像/命令', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'afk-install-'))
    writeFileSync(join(wt, 'pnpm-lock.yaml'), '')
    vi.mocked(execa).mockResolvedValue({ stdout: '', stderr: '' } as never)

    await installDeps(wt, sandboxCfg, undefined, { imageTag: IMAGE })

    const [cmd, args] = vi.mocked(execa).mock.calls[0]
    expect(cmd).toBe('docker')
    const a = args as string[]
    expect(a.slice(0, 2)).toEqual(['run', '--rm'])
    const uid = process.getuid?.()
    if (uid !== undefined) {
      expect(a).toContain('--user')
      expect(a[a.indexOf('--user') + 1]).toBe(`${uid}:${process.getgid?.() ?? uid}`)
    }
    expect(a).toContain(`${wt}:/workspace`) // worktree 挂载直通
    expect(a.some((x) => x.endsWith('/.pi/afk/pi-home:/tmp/pi-home'))).toBe(true) // 宿主 HOME 目录
    expect(a).toContain('-w')
    expect(a[a.indexOf('-w') + 1]).toBe('/workspace')
    expect(a).toContain('--entrypoint')
    expect(a[a.indexOf('--entrypoint') + 1]).toBe('sh')
    expect(a[a.indexOf('sh') + 1]).toBe(IMAGE) // 显式 entrypoint 后紧跟镜像
    expect(a.slice(-2)).toEqual(['-c', 'pnpm install --frozen-lockfile'])
  })

  it('容器 env 走白名单 + CI=true，不含宿主全部 env', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'afk-install-'))
    writeFileSync(join(wt, 'pnpm-lock.yaml'), '')
    const was = process.env.DEEPSEEK_API_KEY
    const wasGht = process.env.GH_TOKEN
    process.env.DEEPSEEK_API_KEY = 'sk-1'
    process.env.GH_TOKEN = 'ghp-secret'
    vi.mocked(execa).mockResolvedValue({ stdout: '', stderr: '' } as never)
    try {
      await installDeps(wt, sandboxCfg, undefined, { imageTag: IMAGE })

      const opts = vi.mocked(execa).mock.calls[0][2]
      const env = (opts as { env: NodeJS.ProcessEnv }).env
      expect(env.CI).toBe('true')
      expect(env.DEEPSEEK_API_KEY).toBe('sk-1') // 白名单命中
      expect(env.GH_TOKEN).toBeUndefined() // 白名单排除
    } finally {
      if (was === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = was
      if (wasGht === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = wasGht
    }
  })

  it('容器内安装失败（exit 非 0）→ 同宿主模式报错格式', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'afk-install-'))
    writeFileSync(join(wt, 'pnpm-lock.yaml'), '')
    vi.mocked(execa).mockRejectedValue({ exitCode: 1, stderr: 'ERR! 容器内解析失败' })

    await expect(installDeps(wt, sandboxCfg, undefined, { imageTag: IMAGE })).rejects.toThrow(
      /依赖安装失败（1）/,
    )
  })
})
