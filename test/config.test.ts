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
} from '../src/config'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'afk-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadGlobalConfig', () => {
  it('无配置文件时返回 4 个默认值', () => {
    const cfg = loadGlobalConfig(join(dir, 'none.json'))
    expect(cfg.image).toBe(DEFAULT_GLOBAL_CONFIG.image)
    expect(cfg.model).toBe(DEFAULT_GLOBAL_CONFIG.model)
    expect(cfg.label).toBe('afk')
    expect(cfg.autoMerge).toBeUndefined()
  })

  it('读取配置文件中的 4 个字段', () => {
    writeFileSync(
      join(dir, 'custom.json'),
      JSON.stringify({
        image: 'custom:latest',
        model: 'custom/model',
        label: 'custom-label',
        autoMerge: true,
      }),
    )
    const cfg = loadGlobalConfig(join(dir, 'custom.json'))
    expect(cfg.image).toBe('custom:latest')
    expect(cfg.model).toBe('custom/model')
    expect(cfg.label).toBe('custom-label')
    expect(cfg.autoMerge).toBe(true)
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
    expect(cfg.label).toBe('afk')
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
