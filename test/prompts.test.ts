import { describe, expect, it } from 'vitest'

import {
  implementerFixPrompt,
  implementerPrompt,
  mergerPrompt,
  reviewerPrompt,
} from '../src/prompts.js'

const issue = {
  number: 52,
  title: '网站链接导航去背景色',
  body: '导航链接有背景色，需要去掉。',
  labels: ['agent:todo'],
}
const branch = 'afk/issue-52-site-links-nav'

/** prompt 不变式：所有 {{占位符}} 都被替换，不残留 */
function assertNoPlaceholders(prompt: string): void {
  expect(prompt).not.toMatch(/\{\{\w+\}\}/)
}

describe('implementer prompt（单阶段）', () => {
  it('无残留占位符，含 issue 内容与分支名', () => {
    const p = implementerPrompt(issue, branch)
    assertNoPlaceholders(p)
    expect(p).toContain('#52')
    expect(p).toContain(issue.body)
    expect(p).toContain(branch)
  })

  it('不再要求 agent 自行安装依赖（编排层宿主侧负责）', () => {
    const p = implementerPrompt(issue, branch)
    expect(p).not.toMatch(/pnpm install/)
    expect(p).toMatch(/依赖已由编排层/)
  })

  it('不残留 {{PLAN}} 占位（planner 已砍，单阶段自主规划）', () => {
    expect(implementerPrompt(issue, branch)).not.toContain('{{PLAN}}')
  })
})

describe('reviewer prompt（codereview）', () => {
  it('无残留占位符，含 issue、分支与 base 分支', () => {
    const p = reviewerPrompt(issue, branch, 'main')
    assertNoPlaceholders(p)
    expect(p).toContain('#52')
    expect(p).toContain(branch)
    expect(p).toContain('main')
    expect(p).toContain('<verdict>')
    expect(p).toContain('approve')
  })
})

describe('implementerFixPrompt（review 修复轮）', () => {
  it('无残留占位符，含 issue 与 review 反馈', () => {
    const p = implementerFixPrompt(issue, branch, '1. src/a.ts: 空指针风险')
    assertNoPlaceholders(p)
    expect(p).toContain('#52')
    expect(p).toContain('空指针风险')
  })
})

describe('mergerPrompt（合并 PR，解冲突是核心职责）', () => {
  it('无残留占位符，含冲突文件清单与 base 分支', () => {
    const p = mergerPrompt(issue, branch, 'main', ['src/a.ts', 'src/b.ts'])
    assertNoPlaceholders(p)
    expect(p).toContain('main')
    expect(p).toContain('src/a.ts')
    expect(p).toContain('src/b.ts')
    expect(p).toContain('Issue #52')
  })

  it('无冲突文件时给 git status 提示（不残留占位符）', () => {
    const p = mergerPrompt(issue, branch, 'main', [])
    assertNoPlaceholders(p)
    expect(p).toContain('git status')
  })
})
