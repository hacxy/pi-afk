import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

import { hostPnpmVersion, dockerBuildArgs } from '../src/sandbox.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('hostPnpmVersion', () => {
  it('返回宿主 pnpm 的 semver 版本（与沙箱镜像注入的构建参数一致）', () => {
    expect(hostPnpmVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('dockerBuildArgs', () => {
  it('包含 PNPM_VERSION / AGENT_UID / AGENT_GID 构建参数', () => {
    const args = dockerBuildArgs({
      image: 'pi-afk:test',
      dockerfile: '/tmp/Dockerfile',
      contextDir: '/tmp',
      uid: 501,
      gid: 20,
      pnpmVersion: '9.15.0',
    })
    expect(args[0]).toBe('build')
    expect(args).toContain('-t')
    expect(args).toContain('pi-afk:test')
    expect(args).toContain('--build-arg')
    expect(args).toContain('PNPM_VERSION=9.15.0')
    expect(args).toContain('AGENT_UID=501')
    expect(args).toContain('AGENT_GID=20')
    expect(args).toContain('-f')
    expect(args).toContain('/tmp/Dockerfile')
    expect(args).toContain('/tmp') // 构建上下文目录
  })
})

describe('Dockerfile pnpm 版本注入', () => {
  it('Dockerfile 使用 ARG PNPM_VERSION，不硬编码 pnpm 版本', () => {
    const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8')
    expect(dockerfile).toMatch(/ARG\s+PNPM_VERSION/)
    expect(dockerfile).toContain('pnpm@${PNPM_VERSION}')
    expect(dockerfile).not.toMatch(/pnpm@\d+\.\d+\.\d+/)
  })
})
