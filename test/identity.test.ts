import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createGitIdentityResolver } from '../src/identity.js'

/** 写一个临时 global gitconfig（GIT_CONFIG_GLOBAL 指向它，替代 ~/.gitconfig） */
function tempGlobalConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'afk-ident-'))
  const file = join(dir, 'gitconfig')
  writeFileSync(file, content)
  return file
}

const ORIGINAL = process.env.GIT_CONFIG_GLOBAL

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = ORIGINAL
})

describe('resolveGitIdentity 身份解析链（config.json > 宿主 global）', () => {
  it('config.json 提供成对身份 → 使用 config 身份，不查 gitconfig', () => {
    process.env.GIT_CONFIG_GLOBAL = tempGlobalConfig('') // 空 global：有 config 就不依赖它

    const resolve = createGitIdentityResolver({
      gitAuthor: 'cfg-name',
      gitEmail: 'cfg@example.com',
    })

    expect(resolve()).toEqual({ name: 'cfg-name', email: 'cfg@example.com' })
  })

  it('config.json 只提供一半 → 抛错（gitAuthor/gitEmail 必须成对）', () => {
    const resolve = createGitIdentityResolver({ gitAuthor: 'only-cfg' })
    expect(() => resolve()).toThrow(/成对/)
  })

  it('无 config → 回落宿主 git config --global（真实 git + GIT_CONFIG_GLOBAL）', () => {
    process.env.GIT_CONFIG_GLOBAL = tempGlobalConfig(
      '[user]\n\tname = global-name\n\temail = global@example.com\n',
    )

    const resolve = createGitIdentityResolver({})

    expect(resolve()).toEqual({ name: 'global-name', email: 'global@example.com' })
  })

  it('config 与 global 都缺失 → 抛错，消息含两条设置路径', () => {
    process.env.GIT_CONFIG_GLOBAL = tempGlobalConfig('') // 空 global：无 user.name/user.email

    const resolve = createGitIdentityResolver({})

    expect(() => resolve()).toThrow(/git config --global/)
    expect(() => resolve()).toThrow(/config.json/)
  })

  it('同一 resolver 二次调用返回首次解析结果（memoize）', () => {
    const resolve = createGitIdentityResolver({
      gitAuthor: 'first',
      gitEmail: 'first@example.com',
    })
    expect(resolve()).toEqual({ name: 'first', email: 'first@example.com' })
    expect(resolve()).toEqual({ name: 'first', email: 'first@example.com' }) // 幂等
  })
})
