import { describe, expect, it } from 'vitest'

import { compareUrl, failureComment, successComment } from '../src/report.js'

describe('compareUrl', () => {
  it('拼出 GitHub compare 链接（base...branch）', () => {
    expect(compareUrl('hacxy/pi-afk', 'main', 'afk/issue-52-site-links-nav')).toBe(
      'https://github.com/hacxy/pi-afk/compare/main...afk/issue-52-site-links-nav',
    )
  })
})

describe('successComment', () => {
  it('包含分支名、PR 链接与 compare 链接', () => {
    const body = successComment({
      branch: 'afk/issue-52-site-links-nav',
      prUrl: 'https://github.com/hacxy/pi-afk/pull/100',
      compareUrl: 'https://github.com/hacxy/pi-afk/compare/main...afk/issue-52-site-links-nav',
    })
    expect(body).toContain('afk/issue-52-site-links-nav')
    expect(body).toContain('https://github.com/hacxy/pi-afk/pull/100')
    expect(body).toContain(
      'https://github.com/hacxy/pi-afk/compare/main...afk/issue-52-site-links-nav',
    )
    expect(body).toContain('✅')
  })
})

describe('failureComment', () => {
  const base = {
    stage: 'implementer',
    exitCode: 2,
    stderr: 'typecheck 失败：不能把 string 赋给 number',
    logPath: '.pi/afk/logs/afk-2026-08-14.log',
    sessionPath: '.pi/afk/sessions/afk-issue-52-site-links-nav-implementer.jsonl',
    archivePath: '.pi/afk/failed/afk/issue-52-site-links-nav',
    todoLabel: 'agent:todo',
  }

  it('包含阶段、退出码、stderr 摘要', () => {
    const body = failureComment(base)
    expect(body).toContain('implementer')
    expect(body).toContain('退出码：2')
    expect(body).toContain('typecheck 失败')
    expect(body).toContain('❌')
  })

  it('包含日志/会话/归档三条产物路径', () => {
    const body = failureComment(base)
    expect(body).toContain('.pi/afk/logs/afk-2026-08-14.log')
    expect(body).toContain('.pi/afk/sessions/afk-issue-52-site-links-nav-implementer.jsonl')
    expect(body).toContain('.pi/afk/failed/afk/issue-52-site-links-nav')
  })

  it('包含改回 todo label 的重跑提示', () => {
    const body = failureComment(base)
    expect(body).toContain('agent:todo')
    expect(body).toContain('重跑')
  })

  it('可选路径缺失时不渲染对应行（如超时无会话、git 阶段无归档）', () => {
    const body = failureComment({
      stage: 'git',
      exitCode: 1,
      stderr: 'worktree add 失败',
      todoLabel: 'agent:todo',
    })
    expect(body).not.toContain('会话')
    expect(body).not.toContain('归档')
    expect(body).toContain('退出码：1')
    expect(body).toContain('worktree add 失败')
  })

  it('超时标记渲染', () => {
    const body = failureComment({ ...base, timedOut: true })
    expect(body).toContain('超时')
  })
})
