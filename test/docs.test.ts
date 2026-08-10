import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

/**
 * 文档-实现一致守卫（issue #9）：
 * README 与 CLI usage 不得宣传未实现的功能（虚假承诺）。
 */

const here = dirname(fileURLToPath(import.meta.url)) // test/
const repoRoot = dirname(here)
const README = readFileSync(join(repoRoot, 'README.md'), 'utf8')
const USAGE_SOURCE = readFileSync(join(repoRoot, 'src', 'cli.ts'), 'utf8')

describe('README 文档-实现一致', () => {
  it('不再出现 GH_TOKEN（代码从不读取该环境变量）', () => {
    expect(README).not.toMatch(/GH_TOKEN/)
  })

  it('不再出现 .afkrc.json / maxIterations（项目级配置层已删除）', () => {
    expect(README).not.toMatch(/\.afkrc\.json/)
    expect(README).not.toMatch(/maxIterations/)
  })
})

describe('CLI usage 文档-实现一致', () => {
  it('不再提及 GH_TOKEN（代码从不读取该环境变量）', () => {
    expect(USAGE_SOURCE).not.toMatch(/GH_TOKEN/)
  })

  it('描述全局唯一 4 字段配置协议', () => {
    expect(USAGE_SOURCE).toMatch(/\.afk\/config\.json/)
    expect(USAGE_SOURCE).toMatch(/image \/ model \/ label \/ autoMerge/)
  })

  it('描述 sandcastle 官方模板协议（.sandcastle/prompt.md）', () => {
    expect(USAGE_SOURCE).toMatch(/\.sandcastle\/prompt\.md/)
  })
})
