import { describe, expect, it } from 'vitest'

import { parsePlan, planSchema } from '../src/plan.js'

const validPlan = {
  number: 52,
  title: '网站链接导航去背景色',
  branch: 'afk/issue-52-site-links-nav',
  summary: '去掉导航链接的背景色',
  files: ['src/components/Nav.tsx'],
  acceptanceCriteria: ['导航链接无背景色'],
  steps: ['定位样式', '移除背景色', '跑测试'],
}

describe('planSchema', () => {
  it('接受合法 plan', () => {
    expect(() => planSchema.parse(validPlan)).not.toThrow()
  })

  it('拒绝缺字段的 plan', () => {
    const { files: _files, ...rest } = validPlan
    expect(() => planSchema.parse(rest)).toThrow()
  })
})

describe('parsePlan', () => {
  it('解析纯 JSON', () => {
    expect(parsePlan(JSON.stringify(validPlan))).toEqual(validPlan)
  })

  it('容错 markdown 代码块', () => {
    const text = `好的，以下是计划：\n\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\``
    expect(parsePlan(text)).toEqual(validPlan)
  })

  it('容错前后杂音', () => {
    const text = `前缀文字 ${JSON.stringify(validPlan)} 后缀文字`
    expect(parsePlan(text)).toEqual(validPlan)
  })

  it('无 JSON 时抛错', () => {
    expect(() => parsePlan('没有 JSON')).toThrow()
  })
})
