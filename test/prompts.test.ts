import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  resolvePromptFile,
  promptFilePath,
  ensureProjectPrompt,
  ensureSandcastleGitignore,
} from '../src/prompts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'afk-prompt-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolvePromptFile', () => {
  it('项目存在 .sandcastle/prompt.md 时优先返回它', () => {
    const projectPrompt = join(dir, '.sandcastle', 'prompt.md')
    mkdirSync(join(dir, '.sandcastle'), { recursive: true })
    writeFileSync(projectPrompt, '# 自定义模板\n')
    expect(resolvePromptFile(dir)).toBe(projectPrompt)
  })

  it('无自定义模板时返回包内默认 prompts/prompt.md', () => {
    expect(resolvePromptFile(dir)).toBe(promptFilePath())
    expect(promptFilePath()).toMatch(/prompts\/prompt\.md$/)
    expect(existsSync(resolvePromptFile(dir))).toBe(true)
  })
})

describe('ensureProjectPrompt', () => {
  it('首次调用把默认模板复制到项目 .sandcastle/prompt.md', () => {
    const target = ensureProjectPrompt(dir)
    expect(target).toBe(join(dir, '.sandcastle', 'prompt.md'))
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(promptFilePath(), 'utf8'))
    // 复制后 resolvePromptFile 应命中项目模板
    expect(resolvePromptFile(dir)).toBe(target)
  })

  it('幂等：已存在时不覆盖用户修改', () => {
    const target = ensureProjectPrompt(dir)
    writeFileSync(target, '# 用户自定义版本\n')
    expect(ensureProjectPrompt(dir)).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe('# 用户自定义版本\n')
  })
})

describe('ensureSandcastleGitignore', () => {
  it('无 .gitignore 时创建，忽略运行时产物但保留 .sandcastle/prompt.md', () => {
    const gitignore = join(dir, '.gitignore')
    ensureSandcastleGitignore(dir)
    const content = readFileSync(gitignore, 'utf8')
    expect(content).toContain('.sandcastle/*')
    expect(content).toContain('!.sandcastle/prompt.md')
    // 不得是整目录忽略（那会连 prompt.md 一起忽略）
    expect(content).not.toMatch(/^\s*\.sandcastle\/\s*$/m)
  })

  it('旧版整目录 .sandcastle/ 忽略行被升级为保留 prompt.md 的规则', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.sandcastle/\ndist/\n')
    ensureSandcastleGitignore(dir)
    const content = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(content).not.toMatch(/^\s*\.sandcastle\/\s*$/m)
    expect(content).toContain('!.sandcastle/prompt.md')
    // 其余规则不受影响
    expect(content).toContain('node_modules/')
    expect(content).toContain('dist/')
  })

  it('幂等：已有新规则时不重复追加', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.sandcastle/*\n!.sandcastle/prompt.md\n')
    ensureSandcastleGitignore(dir)
    const content = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(content.match(/!\.sandcastle\/prompt\.md/g)?.length).toBe(1)
  })
})
