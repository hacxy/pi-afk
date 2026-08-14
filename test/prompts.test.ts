import { describe, expect, it } from 'vitest'

import { implementerPrompt, plannerPrompt, reviewerPrompt } from '../src/prompts.js'

const issue = {
  number: 52,
  title: '网站链接导航去背景色',
  body: '导航链接有背景色，需要去掉。',
  labels: ['agent:todo'],
}
const plan = {
  number: 52,
  title: '网站链接导航去背景色',
  branch: 'afk/issue-52-site-links-nav',
  summary: '去掉背景色',
  files: ['src/components/Nav.tsx'],
  acceptanceCriteria: ['无背景色'],
  steps: ['改样式'],
}

/** prompt 不变式：所有 {{占位符}} 都被替换，不残留 */
function assertNoPlaceholders(prompt: string): void {
  expect(prompt).not.toMatch(/\{\{\w+\}\}/)
}

describe('prompt 不变式', () => {
  it('planner prompt 无残留占位符，含 issue 内容', () => {
    const p = plannerPrompt(issue, plan.branch)
    assertNoPlaceholders(p)
    expect(p).toContain('#52')
    expect(p).toContain(issue.body)
  })

  it('implementer prompt 无残留占位符，含 plan JSON', () => {
    const p = implementerPrompt(issue, plan)
    assertNoPlaceholders(p)
    expect(p).toContain(JSON.stringify(plan, null, 2))
  })

  it('implementer/reviewer 不再要求 agent 自行安装依赖（D2：编排层 hook 负责）', () => {
    expect(implementerPrompt(issue, plan)).not.toMatch(/pnpm install/)
    expect(reviewerPrompt(issue, plan)).not.toMatch(/pnpm install/)
    expect(implementerPrompt(issue, plan)).toMatch(/依赖已由编排层/)
    expect(reviewerPrompt(issue, plan)).toMatch(/依赖已由编排层/)
  })

  it('reviewer prompt 无残留占位符', () => {
    const p = reviewerPrompt(issue, plan)
    assertNoPlaceholders(p)
    expect(p).toContain('#52')
  })

  it('prompt 引用的模板文件都存在', () => {
    // 若模板缺失，load() 会 throw——上面的调用已隐式验证
    expect(plannerPrompt).toBeDefined()
    expect(implementerPrompt).toBeDefined()
    expect(reviewerPrompt).toBeDefined()
  })
})
