import { describe, it, expect } from 'vitest'

import { loadGlobalConfig, DEFAULT_GLOBAL_CONFIG } from '../src/config'

describe('loadGlobalConfig', () => {
  it('无配置文件时返回默认值', () => {
    const cfg = loadGlobalConfig()
    expect(cfg.image).toBe(DEFAULT_GLOBAL_CONFIG.image)
    expect(cfg.model).toBe(DEFAULT_GLOBAL_CONFIG.model)
    expect(cfg.label).toBe('afk')
  })

  it('logDir 展开 ~ 为用户主目录', () => {
    const cfg = loadGlobalConfig()
    expect(cfg.logDir.startsWith('/Users/') || cfg.logDir.startsWith('/home/')).toBe(true)
    expect(cfg.logDir).not.toContain('~')
  })
})
