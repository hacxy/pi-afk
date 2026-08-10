import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  loadGlobalConfig,
  DEFAULT_GLOBAL_CONFIG,
  LOG_DIR,
  COMPLETION_SIGNAL,
  ensureGlobalDirs,
} from '../src/config.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'afk-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadGlobalConfig', () => {
  it('无配置文件时返回默认值（labels 默认空 = 不过滤，verifyCommand 默认缺省）', () => {
    const cfg = loadGlobalConfig(join(dir, 'none.json'))
    expect(cfg.image).toBe(DEFAULT_GLOBAL_CONFIG.image)
    expect(cfg.model).toBe(DEFAULT_GLOBAL_CONFIG.model)
    expect(cfg.labels).toEqual([])
    expect(cfg.autoMerge).toBeUndefined()
    expect(cfg.verifyCommand).toBeUndefined()
  })

  it('verifyCommand：缺失/空串 → undefined（跳过验证，行为不变）', () => {
    // 未配置字段：undefined
    writeFileSync(join(dir, 'no-verify.json'), JSON.stringify({}))
    expect(loadGlobalConfig(join(dir, 'no-verify.json')).verifyCommand).toBeUndefined()
    // 空串：undefined
    writeFileSync(join(dir, 'empty-verify.json'), JSON.stringify({ verifyCommand: '' }))
    expect(loadGlobalConfig(join(dir, 'empty-verify.json')).verifyCommand).toBeUndefined()
    // 纯空白：undefined
    writeFileSync(join(dir, 'blank-verify.json'), JSON.stringify({ verifyCommand: '   ' }))
    expect(loadGlobalConfig(join(dir, 'blank-verify.json')).verifyCommand).toBeUndefined()
  })

  it('verifyCommand：读取配置的验证命令字符串', () => {
    writeFileSync(
      join(dir, 'verify.json'),
      JSON.stringify({ verifyCommand: 'pnpm typecheck && pnpm test:run' }),
    )
    expect(loadGlobalConfig(join(dir, 'verify.json')).verifyCommand).toBe(
      'pnpm typecheck && pnpm test:run',
    )
  })

  it('读取配置文件中的 labels 数组', () => {
    writeFileSync(
      join(dir, 'custom.json'),
      JSON.stringify({
        image: 'custom:latest',
        model: 'custom/model',
        labels: ['afk', 'ready-for-agent'],
        autoMerge: true,
      }),
    )
    const cfg = loadGlobalConfig(join(dir, 'custom.json'))
    expect(cfg.image).toBe('custom:latest')
    expect(cfg.model).toBe('custom/model')
    expect(cfg.labels).toEqual(['afk', 'ready-for-agent'])
    expect(cfg.autoMerge).toBe(true)
  })

  it('旧字段 label（字符串/数组）自动迁移为 labels 数组，labels 优先', () => {
    writeFileSync(
      join(dir, 'legacy.json'),
      JSON.stringify({
        label: 'afk',
      }),
    )
    expect(loadGlobalConfig(join(dir, 'legacy.json')).labels).toEqual(['afk'])
    // labels 与旧 label 同时存在时 labels 优先
    writeFileSync(
      join(dir, 'both.json'),
      JSON.stringify({
        label: 'legacy-label',
        labels: ['new-label'],
      }),
    )
    expect(loadGlobalConfig(join(dir, 'both.json')).labels).toEqual(['new-label'])
    // 旧 label 为数组
    writeFileSync(
      join(dir, 'legacy-array.json'),
      JSON.stringify({
        label: ['a', 'b'],
      }),
    )
    expect(loadGlobalConfig(join(dir, 'legacy-array.json')).labels).toEqual(['a', 'b'])
  })

  it('labels 非法值（非字符串/空串）被过滤，全非法回退空数组', () => {
    writeFileSync(
      join(dir, 'dirty.json'),
      JSON.stringify({
        labels: ['ok', 42, '', null],
      }),
    )
    expect(loadGlobalConfig(join(dir, 'dirty.json')).labels).toEqual(['ok'])
    writeFileSync(
      join(dir, 'dirty2.json'),
      JSON.stringify({
        labels: 'afk', // 字符串不是数组，也兼容为单个
      }),
    )
    expect(loadGlobalConfig(join(dir, 'dirty2.json')).labels).toEqual(['afk'])
  })

  it('verifyCommand 与其他字段并存时互不影响', () => {
    writeFileSync(
      join(dir, 'mix.json'),
      JSON.stringify({ image: 'custom:latest', verifyCommand: 'make test' }),
    )
    const cfg = loadGlobalConfig(join(dir, 'mix.json'))
    expect(cfg.image).toBe('custom:latest')
    expect(cfg.verifyCommand).toBe('make test')
    expect(cfg.model).toBe(DEFAULT_GLOBAL_CONFIG.model)
  })

  it('旧格式字段（logDir/completionSignal/promptFile）被忽略且不报错', () => {
    writeFileSync(
      join(dir, 'old.json'),
      JSON.stringify({
        image: 'custom:latest',
        logDir: '~/custom-logs',
        completionSignal: '<custom>DONE</custom>',
        promptFile: '~/my-prompts/x.md',
        maxIterations: 5,
      }),
    )
    const cfg = loadGlobalConfig(join(dir, 'old.json'))
    // 有效字段照常生效
    expect(cfg.image).toBe('custom:latest')
    // 缺失字段回退默认
    expect(cfg.model).toBe(DEFAULT_GLOBAL_CONFIG.model)
    expect(cfg.labels).toEqual([])
    expect(cfg.autoMerge).toBeUndefined()
    // 旧字段被忽略，不进入返回对象
    expect(cfg).not.toHaveProperty('logDir')
    expect(cfg).not.toHaveProperty('completionSignal')
    expect(cfg).not.toHaveProperty('promptFile')
  })
})

describe('固定常量', () => {
  it('LOG_DIR 固定为展开后的 ~/.afk/logs', () => {
    expect(LOG_DIR).toBe(join(homedir(), '.afk', 'logs'))
    expect(LOG_DIR).not.toContain('~')
  })

  it('COMPLETION_SIGNAL 固定为 <promise>COMPLETE</promise>', () => {
    expect(COMPLETION_SIGNAL).toBe('<promise>COMPLETE</promise>')
  })
})

describe('ensureGlobalDirs', () => {
  it('返回固定日志目录并确保其存在', () => {
    expect(ensureGlobalDirs()).toBe(LOG_DIR)
    expect(existsSync(LOG_DIR)).toBe(true)
  })
})
