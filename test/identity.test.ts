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

/** 原始环境快照：每个测试后恢复，防止串扰 */
const ORIGINAL = {
  author: process.env.AFK_GIT_AUTHOR,
  email: process.env.AFK_GIT_EMAIL,
  gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL,
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  restoreEnv('AFK_GIT_AUTHOR', ORIGINAL.author)
  restoreEnv('AFK_GIT_EMAIL', ORIGINAL.email)
  restoreEnv('GIT_CONFIG_GLOBAL', ORIGINAL.gitConfigGlobal)
})

describe('resolveGitIdentity 身份解析链', () => {
  it('AFK_GIT_AUTHOR/EMAIL 双设 → 直接返回，不依赖 gitconfig', () => {
    process.env.AFK_GIT_AUTHOR = 'override-name'
    process.env.AFK_GIT_EMAIL = 'override@example.com'

    const resolve = createGitIdentityResolver()

    expect(resolve()).toEqual({ name: 'override-name', email: 'override@example.com' })
  })

  it('env 未设 → 回落宿主 git config --global（真实 git + GIT_CONFIG_GLOBAL）', () => {
    delete process.env.AFK_GIT_AUTHOR
    delete process.env.AFK_GIT_EMAIL
    process.env.GIT_CONFIG_GLOBAL = tempGlobalConfig(
      '[user]\n\tname = global-name\n\temail = global@example.com\n',
    )

    const resolve = createGitIdentityResolver()

    expect(resolve()).toEqual({ name: 'global-name', email: 'global@example.com' })
  })

  it('env 与 global 都缺失 → 抛错，消息含两条设置路径', () => {
    delete process.env.AFK_GIT_AUTHOR
    delete process.env.AFK_GIT_EMAIL
    process.env.GIT_CONFIG_GLOBAL = tempGlobalConfig('') // 空 global：无 user.name/user.email

    const resolve = createGitIdentityResolver()

    expect(() => resolve()).toThrow(/git config --global/)
    expect(() => resolve()).toThrow(/AFK_GIT_AUTHOR/)
  })

  it('env 只设一半 → 抛错（AFK_GIT_* 必须成对）', () => {
    process.env.AFK_GIT_AUTHOR = 'only-name'
    delete process.env.AFK_GIT_EMAIL

    const resolve = createGitIdentityResolver()

    expect(() => resolve()).toThrow(/同时设置/)
  })

  it('env 空串/空白视为未设置 → 回落 global', () => {
    process.env.AFK_GIT_AUTHOR = ''
    process.env.AFK_GIT_EMAIL = '   '
    process.env.GIT_CONFIG_GLOBAL = tempGlobalConfig(
      '[user]\n\tname = fallback-name\n\temail = fallback@example.com\n',
    )

    const resolve = createGitIdentityResolver()

    expect(resolve()).toEqual({ name: 'fallback-name', email: 'fallback@example.com' })
  })

  it('同一 resolver 二次调用返回首次解析结果（memoize）', () => {
    process.env.AFK_GIT_AUTHOR = 'first'
    process.env.AFK_GIT_EMAIL = 'first@example.com'

    const resolve = createGitIdentityResolver()
    expect(resolve()).toEqual({ name: 'first', email: 'first@example.com' })

    // 解析后环境变化不影响已缓存结果
    process.env.AFK_GIT_AUTHOR = 'second'
    expect(resolve()).toEqual({ name: 'first', email: 'first@example.com' })
  })
})
