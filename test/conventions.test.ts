import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url)) // test/
const repoRoot = dirname(here)

/**
 * 代码库规范守卫（issue #11）：
 * 1. 测试文件相对导入带 .js 后缀，与源码 NodeNext 规范一致；
 * 2. 源码注释不再出现 "共识 X" 式设计过程引用（已全部改写为描述性注释）。
 */

describe('测试导入规范', () => {
  it('所有测试文件的相对导入统一带 .js 后缀', () => {
    const offenders: string[] = []
    for (const file of readdirSync(here).filter((f) => f.endsWith('.test.ts'))) {
      const content = readFileSync(join(here, file), 'utf8')
      for (const line of content.split('\n')) {
        for (const m of line.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
          if (!m[1].endsWith('.js')) {
            offenders.push(`${file}: ${m[1]}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('源码注释规范', () => {
  it('src/ 注释不再出现 "共识 X" 式设计过程引用', () => {
    const offenders: string[] = []
    for (const file of readdirSync(join(repoRoot, 'src')).filter((f) => f.endsWith('.ts'))) {
      const content = readFileSync(join(repoRoot, 'src', file), 'utf8')
      for (const line of content.split('\n')) {
        if (/共识\s*[A-Z]+\d/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
