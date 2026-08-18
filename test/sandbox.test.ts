import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'

import { DEFAULT_SANDBOX_ENV } from '../src/config.js'
import {
  defaultDockerfile,
  detectNodeVersion,
  filterSandboxEnv,
  requireSandboxImage,
  sandboxImageTag,
} from '../src/sandbox.js'

const FULL_ENV: NodeJS.ProcessEnv = {
  DEEPSEEK_API_KEY: 'sk-deepseek',
  ANTHROPIC_API_KEY: 'sk-anthropic',
  OPENAI_API_KEY: 'sk-openai',
  HTTPS_PROXY: 'http://proxy:8080',
  PI_MAX_THINKING_TOKENS: '32000',
  PI_MCP_SERVERS: 'x',
  GIT_AUTHOR_NAME: 'hacxy',
  GIT_COMMITTER_EMAIL: 'hacxy@example.com',
  GH_TOKEN: 'ghp_secret',
  GH_HOST: 'github.com',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  HOME: '/Users/hacxy',
  PATH: '/usr/bin',
  AFK_MODEL: 'env-stale',
}

describe('filterSandboxEnv 白名单过滤', () => {
  it('白名单内的模型 API key 与代理透传，白名单外全部排除', () => {
    const out = filterSandboxEnv(FULL_ENV, DEFAULT_SANDBOX_ENV)

    expect(out.DEEPSEEK_API_KEY).toBe('sk-deepseek')
    expect(out.ANTHROPIC_API_KEY).toBe('sk-anthropic')
    expect(out.OPENAI_API_KEY).toBe('sk-openai')
    expect(out.HTTPS_PROXY).toBe('http://proxy:8080')
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(out.HOME).toBeUndefined()
    expect(out.PATH).toBeUndefined()
    expect(out.AFK_MODEL).toBeUndefined()
  })

  it('GH_TOKEN 明确不在默认白名单 → 绝不放行（gh 在宿主侧跑）', () => {
    const out = filterSandboxEnv(FULL_ENV, DEFAULT_SANDBOX_ENV)

    expect(out.GH_TOKEN).toBeUndefined()
    expect(out.GH_HOST).toBeUndefined()
  })

  it('通配项 PI_*：前缀命中即透传', () => {
    const out = filterSandboxEnv(FULL_ENV, DEFAULT_SANDBOX_ENV)

    expect(out.PI_MAX_THINKING_TOKENS).toBe('32000')
    expect(out.PI_MCP_SERVERS).toBe('x')
  })

  it('git 提交身份四件套在默认白名单内（宿主注入通道）', () => {
    const out = filterSandboxEnv(FULL_ENV, DEFAULT_SANDBOX_ENV)

    expect(out.GIT_AUTHOR_NAME).toBe('hacxy')
    expect(out.GIT_COMMITTER_EMAIL).toBe('hacxy@example.com')
  })

  it('config 自定义 sandboxEnv：追加的键透传，原白名单失效', () => {
    const out = filterSandboxEnv(FULL_ENV, ['MY_CUSTOM_KEY', 'DEEPSEEK_API_KEY'])

    expect(out.DEEPSEEK_API_KEY).toBe('sk-deepseek') // 显式点名仍放行
    expect(out.ANTHROPIC_API_KEY).toBeUndefined() // 未点名 → 不放行
    expect(out.GH_TOKEN).toBeUndefined()
  })

  it('env 中未设置的键不补齐（容器里没有多余变量）', () => {
    const out = filterSandboxEnv({ DEEPSEEK_API_KEY: 'sk-1' }, DEFAULT_SANDBOX_ENV)

    expect(out).toEqual({ DEEPSEEK_API_KEY: 'sk-1' })
  })
})

describe('defaultDockerfile 沙箱镜像模板', () => {
  it('基底 node:24-bookworm-slim + 基础工具 + 包管理器 + pi 版本写死', () => {
    const df = defaultDockerfile('0.2.3')

    expect(df).toContain('FROM node:24-bookworm-slim')
    expect(df).toContain('git')
    expect(df).toContain('ripgrep')
    expect(df).toContain('unzip') // bun 安装器依赖
    expect(df).toContain('curl')
    expect(df).toContain('pnpm && npm install -g --ignore-scripts --force yarn') // pnpm + --force 覆盖镜像内置旧 yarn
    expect(df).toContain('@earendil-works/pi-coding-agent@0.2.3') // 写死宿主 pi 版本，不漂移
    expect(df).toContain('bun.sh/install') // bun 官方安装脚本
    expect(df).toContain('WORKDIR /workspace')
    expect(df).toContain('ENTRYPOINT ["pi"]')
  })

  it('nodeMajor 参数控制基底 tag', () => {
    expect(defaultDockerfile('0.2.3', '22')).toContain('FROM node:22-bookworm-slim')
  })

  it('pi 版本缺失/空串 → 抛错（镜像必须版本确定，防漂移）', () => {
    expect(() => defaultDockerfile('')).toThrow(/pi 版本/)
    expect(() => defaultDockerfile('  ')).toThrow(/pi 版本/)
  })
})

describe('detectNodeVersion 基底版本探测', () => {
  function pkgCwd(engines?: { node?: string }): string {
    const cwd = mkdtempSync(join(tmpdir(), 'afk-node-'))
    const pkg = engines ? { engines } : {}
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg))
    return cwd
  }

  it('无 package.json → 默认 node:24', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'afk-node-'))
    expect(detectNodeVersion(cwd)).toBe('24')
  })

  it('无 engines.node → 默认 node:24', () => {
    expect(detectNodeVersion(pkgCwd())).toBe('24')
  })

  it('engines.node >=20 → node:20', () => {
    expect(detectNodeVersion(pkgCwd({ node: '>=20' }))).toBe('20')
  })

  it('engines.node ^22.0.0 → node:22', () => {
    expect(detectNodeVersion(pkgCwd({ node: '^22.0.0' }))).toBe('22')
  })

  it('engines.node 低于支持的基线（>=16）→ clamp 到最低 node:20', () => {
    expect(detectNodeVersion(pkgCwd({ node: '>=16' }))).toBe('20')
  })

  it('engines.node 高于 24 → clamp 到 node:24', () => {
    expect(detectNodeVersion(pkgCwd({ node: '>=26' }))).toBe('24')
  })

  it('engines.node 无法解析 → 默认 node:24', () => {
    expect(detectNodeVersion(pkgCwd({ node: 'banana' }))).toBe('24')
  })
})

describe('sandboxImageTag 内容寻址镜像 tag', () => {
  function projCwd(dockerfile: string | undefined): string {
    const cwd = mkdtempSync(join(tmpdir(), 'afk-tag-'))
    if (dockerfile !== undefined) {
      const dir = join(cwd, '.pi', 'afk')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'Dockerfile'), dockerfile)
    }
    return cwd
  }

  it('tag = afk-sandbox-<Dockerfile sha256 前 16>，确定性', () => {
    const cwd = projCwd('FROM node:24-bookworm-slim\n')
    const a = sandboxImageTag(cwd)
    const b = sandboxImageTag(cwd)
    expect(a).toMatch(/^afk-sandbox-[0-9a-f]{16}$/)
    expect(b).toBe(a)
  })

  it('Dockerfile 内容变 → tag 变（改动即重建的信号）', () => {
    const cwd = projCwd('FROM node:24-bookworm-slim\n')
    const before = sandboxImageTag(cwd)
    writeFileSync(join(cwd, '.pi', 'afk', 'Dockerfile'), 'FROM node:22-bookworm-slim\n')
    expect(sandboxImageTag(cwd)).not.toBe(before)
  })

  it('Dockerfile 缺失 → 抛错提示 afk init', () => {
    const cwd = projCwd(undefined)
    expect(() => sandboxImageTag(cwd)).toThrow(/afk init/)
  })
})

describe('requireSandboxImage run 时镜像校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function projCwd(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'afk-require-'))
    const dir = join(cwd, '.pi', 'afk')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:24-bookworm-slim\n')
    return cwd
  }

  it('镜像存在（docker inspect exit 0）→ 返回 tag', async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)

    const tag = await requireSandboxImage(projCwd())

    expect(tag).toMatch(/^afk-sandbox-/)
    expect(execa).toHaveBeenCalledWith(
      'docker',
      ['image', 'inspect', '--format', '{{.Id}}', tag],
      expect.anything(),
    )
  })

  it('镜像未构建（exit 1）→ 报错并提示重跑 afk init，绝不降级', async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 1 } as never)
    await expect(requireSandboxImage(projCwd())).rejects.toThrow(/afk init/)
  })

  it('docker 不存在（spawn ENOENT）→ 报错提示 docker 不可用或 --local', async () => {
    const err = new Error('spawn docker ENOENT') as Error & { code?: string }
    err.code = 'ENOENT'
    vi.mocked(execa).mockRejectedValue(err)
    await expect(requireSandboxImage(projCwd())).rejects.toThrow(/docker 不可用/)
  })
})
