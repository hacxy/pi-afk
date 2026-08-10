import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'

import {
  hostPnpmVersion,
  dockerBuildArgs,
  buildBranchStrategy,
  buildSandboxLogging,
} from '../src/sandbox.js'

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

describe('buildSandboxLogging（issue #34 终端实时输出）', () => {
  it('带 onAgentStreamEvent 时透传实时回调（流式到终端），日志文件路径不变（#33 完整落盘）', () => {
    const sink = vi.fn()
    const logging = buildSandboxLogging('/proj/.sandcastle/logs/issue-1.log', sink)
    expect(logging.type).toBe('file')
    expect(logging.path).toBe('/proj/.sandcastle/logs/issue-1.log')
    expect(logging.onAgentStreamEvent).toBe(sink)
  })

  it('缺省回调时只写日志文件（行为与 issue #33 一致，不引入多余字段）', () => {
    expect(buildSandboxLogging('/proj/.sandcastle/logs/issue-1.log')).toEqual({
      type: 'file',
      path: '/proj/.sandcastle/logs/issue-1.log',
    })
  })
})

describe('buildBranchStrategy', () => {
  it('传入 baseBranch 时 branch 策略携带 baseBranch（worktree 从 origin/main 创建）', () => {
    expect(buildBranchStrategy('agent/issue-20', 'origin/main')).toEqual({
      type: 'branch',
      branch: 'agent/issue-20',
      baseBranch: 'origin/main',
    })
  })

  it('未传 baseBranch 时省略该字段（sandcastle 默认 HEAD 基线）', () => {
    expect(buildBranchStrategy('agent/issue-20')).toEqual({
      type: 'branch',
      branch: 'agent/issue-20',
    })
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

describe('Dockerfile Playwright/Chromium 预装', () => {
  it('预装 chromium 系统依赖与浏览器二进制（精简 Debian 缺库，agent 无 root 无法现装）', () => {
    const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8')
    // 系统依赖：playwright 官方 install-deps（不手写硬编码 apt 列表）
    expect(dockerfile).toMatch(/install-deps\s+chromium/)
    // 浏览器二进制：预下载到共享目录，agent 可写以便增量补齐
    expect(dockerfile).toMatch(/install\s+chromium/)
    expect(dockerfile).toContain('PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright')
    expect(dockerfile).toContain('chown -R ${AGENT_UID}:${AGENT_GID} /opt/ms-playwright')
    // AGENT_UID/GID 必须声明在浏览器预装之前（chown 需对齐最终 UID）
    const uidLine = dockerfile.indexOf('ARG AGENT_UID')
    const playwrightLine = dockerfile.indexOf('install-deps')
    expect(uidLine).toBeGreaterThan(-1)
    expect(playwrightLine).toBeGreaterThan(uidLine)
  })
})
