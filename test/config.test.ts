import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_SANDBOX_ENV, loadConfig } from '../src/config.js'

/** 建临时项目根目录（默认不含任何 afk 配置） */
function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), 'afk-config-'))
}

/** 写 .pi/afk/config.json 到 cwd */
function writeConfig(cwd: string, content: string | object): void {
  const dir = join(cwd, '.pi', 'afk')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
  )
}

describe('loadConfig 加载与校验', () => {
  it('缺 config.json → 抛错并提示执行 afk init', () => {
    const cwd = tempCwd()
    expect(() => loadConfig(cwd)).toThrow(/afk init/)
  })

  it('空对象 {} → 全部内置默认值', () => {
    const cwd = tempCwd()
    writeConfig(cwd, {})

    const cfg = loadConfig(cwd)

    expect(cfg).toEqual({
      model: 'deepseek/deepseek-v4-flash',
      sandbox: true,
      sandboxEnv: DEFAULT_SANDBOX_ENV,
      thinking: 'medium',
      maxParallel: 2,
      todoLabel: 'agent:todo',
      doneLabel: 'agent:done',
      failedLabel: 'agent:failed',
      branchPrefix: 'afk',
      baseBranch: 'main',
      worktreesDir: '.pi/afk/worktrees',
      failedDir: '.pi/afk/failed',
      logsDir: '.pi/afk/logs',
      sessionsDir: '.pi/afk/sessions',
      idleTimeoutSec: 600,
      completionTimeoutSec: 60,
      autoMerge: false,
      mergedLabel: 'agent:merged',
      maxReviewRounds: 2,
      conflictTries: 2,
      waitForChecks: true,
      mergeTimeoutSec: 600,
    })
    expect(cfg.installCmd).toBeUndefined()
    expect(cfg.gitAuthor).toBeUndefined()
    expect(cfg.gitEmail).toBeUndefined()
    expect(cfg.reviewerModel).toBeUndefined()
  })

  it('空对象 {} → 沙箱默认开启 + 默认白名单 env，无资源限制', () => {
    const cwd = tempCwd()
    writeConfig(cwd, {})

    const cfg = loadConfig(cwd)

    expect(cfg.sandbox).toBe(true)
    expect(cfg.sandboxEnv).toEqual(expect.arrayContaining(['DEEPSEEK_API_KEY']))
    expect(cfg.sandboxMemory).toBeUndefined()
    expect(cfg.sandboxCpus).toBeUndefined()
  })

  it('sandbox: false → 沙箱关闭（--local 的持久化形态）', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { sandbox: false })
    expect(loadConfig(cwd).sandbox).toBe(false)
  })

  it('sandboxEnv 自定义 → 覆盖默认白名单', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { sandboxEnv: ['MY_CUSTOM_KEY', 'OTHER_SECRET'] })

    const cfg = loadConfig(cwd)
    expect(cfg.sandboxEnv).toEqual(['MY_CUSTOM_KEY', 'OTHER_SECRET'])
  })

  it('sandboxMemory/sandboxCpus 可选：合法值原样解析', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { sandboxMemory: '4g', sandboxCpus: 2 })

    const cfg = loadConfig(cwd)
    expect(cfg.sandboxMemory).toBe('4g')
    expect(cfg.sandboxCpus).toBe(2)
  })

  it('sandboxMemory 非字符串/sandboxCpus 非正整数 → 报错并定位键名', () => {
    for (const bad of [
      { sandboxMemory: 4 },
      { sandboxMemory: '' },
      { sandboxCpus: 0 },
      { sandboxCpus: 1.5 },
    ]) {
      const cwd = tempCwd()
      writeConfig(cwd, bad)
      expect(() => loadConfig(cwd)).toThrow(/sandbox/)
    }
  })

  it('AFK_* 环境变量不再覆盖任何配置（配置只读 config.json）', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { model: 'file-model', maxParallel: 2 })
    process.env.AFK_MODEL = 'env-model'
    process.env.AFK_MAX_PARALLEL = '7'

    const cfg = loadConfig(cwd)

    expect(cfg.model).toBe('file-model') // env 彻底失效
    expect(cfg.maxParallel).toBe(2)
    delete process.env.AFK_MODEL
    delete process.env.AFK_MAX_PARALLEL
  })

  it('部分键 → 其余回落内置默认值', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { model: 'file-model', baseBranch: 'develop' })

    const cfg = loadConfig(cwd)

    expect(cfg.model).toBe('file-model')
    expect(cfg.baseBranch).toBe('develop')
    expect(cfg.thinking).toBe('medium')
    expect(cfg.maxParallel).toBe(2)
    expect(cfg.todoLabel).toBe('agent:todo')
  })

  it('未知键 → 报错并定位键名（zod .strict()）', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { maxParalell: 3 })

    expect(() => loadConfig(cwd)).toThrow(/maxParalell/)
  })

  it('thinking 非法值 → 报错并定位键名', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { thinking: 'turbo' })

    expect(() => loadConfig(cwd)).toThrow(/thinking/)
  })

  it('maxParallel 非法（0/负数/非整数）→ 报错并定位键名', () => {
    for (const bad of [0, -1, 1.5]) {
      const cwd = tempCwd()
      writeConfig(cwd, { maxParallel: bad })
      expect(() => loadConfig(cwd)).toThrow(/maxParallel/)
    }
  })

  it('非法 JSON → 报错（配置解析失败）', () => {
    const cwd = tempCwd()
    writeConfig(cwd, '{broken')

    expect(() => loadConfig(cwd)).toThrow(/配置解析失败/)
  })

  it('顶层非对象（数组/字符串）→ 报错', () => {
    for (const bad of ['[1,2]', '"str"']) {
      const cwd = tempCwd()
      writeConfig(cwd, bad)
      expect(() => loadConfig(cwd)).toThrow(/顶层必须是 JSON 对象/)
    }
  })

  it('可选身份键：合法字符串原样解析，缺省为 undefined', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { gitAuthor: 'hacxy', gitEmail: 'hacxy@example.com' })

    const cfg = loadConfig(cwd)
    expect(cfg.gitAuthor).toBe('hacxy')
    expect(cfg.gitEmail).toBe('hacxy@example.com')
  })

  it('完整流程新键：config.json 解析 + env 覆盖（布尔/数字/可选）', () => {
    const cwd = tempCwd()
    writeConfig(cwd, {
      autoMerge: true,
      mergedLabel: 'done',
      reviewerModel: 'reviewer-model',
      maxReviewRounds: 3,
      conflictTries: 5,
      waitForChecks: false,
      mergeTimeoutSec: 120,
    })

    const cfg = loadConfig(cwd)
    expect(cfg.autoMerge).toBe(true)
    expect(cfg.mergedLabel).toBe('done')
    expect(cfg.reviewerModel).toBe('reviewer-model')
    expect(cfg.maxReviewRounds).toBe(3)
    expect(cfg.conflictTries).toBe(5)
    expect(cfg.waitForChecks).toBe(false)
    expect(cfg.mergeTimeoutSec).toBe(120)
  })

  it('完整流程新键非法值 → 报错并定位键名', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { maxReviewRounds: 0 })
    expect(() => loadConfig(cwd)).toThrow(/maxReviewRounds/)
  })
})
