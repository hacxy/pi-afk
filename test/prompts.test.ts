import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  resolvePromptFile,
  promptFilePath,
  ensureProjectPrompt,
  ensureSandcastleGitignore,
} from '../src/prompts.js'

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
  it('无 .gitignore 时创建，追加 sandcastle 官方三条（非整目录）', () => {
    const gitignore = join(dir, '.gitignore')
    ensureSandcastleGitignore(dir)
    const content = readFileSync(gitignore, 'utf8')
    expect(content).toContain('.sandcastle/.env')
    expect(content).toContain('.sandcastle/logs/')
    expect(content).toContain('.sandcastle/worktrees/')
    // 不得是整目录忽略（那会连 prompt.md 一起忽略）
    expect(content).not.toMatch(/^\s*\.sandcastle\/\s*$/m)
    // 也不得用 .sandcastle/* + 放行 prompt.md 的近似方案
    expect(content).not.toContain('.sandcastle/*')
    expect(content).not.toContain('!.sandcastle/prompt.md')
  })

  it('旧版整目录 .sandcastle/ 忽略行被迁移为官方三条', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.sandcastle/\ndist/\n')
    ensureSandcastleGitignore(dir)
    const content = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(content).not.toMatch(/^\s*\.sandcastle\/\s*$/m)
    expect(content).toContain('.sandcastle/.env')
    expect(content).toContain('.sandcastle/logs/')
    expect(content).toContain('.sandcastle/worktrees/')
    // 其余规则不受影响
    expect(content).toContain('node_modules/')
    expect(content).toContain('dist/')
  })

  it('旧版 .sandcastle/* + !.sandcastle/prompt.md 块被迁移为官方三条', () => {
    writeFileSync(
      join(dir, '.gitignore'),
      'node_modules/\n# pi-afk 运行时工作区（.sandcastle/prompt.md 除外，可提交共享）\n.sandcastle/*\n!.sandcastle/prompt.md\n',
    )
    ensureSandcastleGitignore(dir)
    const content = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(content).not.toContain('.sandcastle/*')
    expect(content).not.toContain('!.sandcastle/prompt.md')
    expect(content).toContain('.sandcastle/.env')
    expect(content).toContain('.sandcastle/worktrees/')
  })

  it('幂等：已有官方三条时不重复追加', () => {
    writeFileSync(
      join(dir, '.gitignore'),
      'node_modules/\n.sandcastle/.env\n.sandcastle/logs/\n.sandcastle/worktrees/\n',
    )
    ensureSandcastleGitignore(dir)
    const content = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(content.match(/\.sandcastle\/worktrees\//g)?.length).toBe(1)
  })

  it('git 集成：prompt.md 可被跟踪，运行时产物被忽略', () => {
    mkdirSync(join(dir, '.sandcastle', 'worktrees'), { recursive: true })
    writeFileSync(join(dir, '.sandcastle', 'prompt.md'), '# 团队共享模板\n')
    writeFileSync(join(dir, '.sandcastle', '.env'), 'KEY=secret\n')
    writeFileSync(join(dir, '.sandcastle', 'worktrees', 'tmp.txt'), 'x\n')
    ensureSandcastleGitignore(dir)

    execFileSync('git', ['init', '-q'], { cwd: dir })
    const isIgnored = (p: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', p], { cwd: dir })
        return true
      } catch {
        return false
      }
    }
    expect(isIgnored('.sandcastle/.env')).toBe(true)
    expect(isIgnored('.sandcastle/worktrees/tmp.txt')).toBe(true)
    expect(isIgnored('.sandcastle/prompt.md')).toBe(false)
  })
})
