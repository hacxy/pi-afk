import { describe, expect, it } from 'vitest'

import { parseCliArgs } from '../src/cli.js'

describe('parseCliArgs 参数解析', () => {
  it('无参数 → 无人值守循环', () => {
    expect(parseCliArgs([])).toEqual({ command: 'loop' })
  })

  it('afk run "<prompt>" → run 命令', () => {
    expect(parseCliArgs(['run', '实现登录页'])).toEqual({ command: 'run', prompt: '实现登录页' })
  })

  it('prompt 多词完整拼接', () => {
    expect(parseCliArgs(['run', '修复', '登录', 'bug'])).toEqual({
      command: 'run',
      prompt: '修复 登录 bug',
    })
  })

  it('run 缺 prompt → 报错', () => {
    expect(parseCliArgs(['run'])).toEqual({
      command: 'error',
      error: expect.stringContaining('prompt'),
    })
  })

  it('--help / -h → help', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' })
    expect(parseCliArgs(['-h'])).toEqual({ command: 'help' })
    expect(parseCliArgs(['help'])).toEqual({ command: 'help' })
  })

  it('未知命令 → 报错', () => {
    expect(parseCliArgs(['frobnicate'])).toEqual({
      command: 'error',
      error: expect.stringContaining('frobnicate'),
    })
  })
})
