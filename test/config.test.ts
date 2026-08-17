import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'

/** 配置相关环境变量：每个测试后恢复，防止串扰 */
const ENV_KEYS = [
  'AFK_MODEL',
  'AFK_THINKING',
  'AFK_MAX_PARALLEL',
  'AFK_TODO_LABEL',
  'AFK_DONE_LABEL',
  'AFK_FAILED_LABEL',
  'AFK_BRANCH_PREFIX',
  'AFK_BASE_BRANCH',
  'AFK_WORKTREES_DIR',
  'AFK_FAILED_DIR',
  'AFK_LOGS_DIR',
  'AFK_SESSIONS_DIR',
  'AFK_INSTALL_CMD',
  'AFK_IDLE_TIMEOUT_SEC',
  'AFK_COMPLETION_TIMEOUT_SEC',
  'AFK_AUTO_MERGE',
  'AFK_MERGED_LABEL',
  'AFK_REVIEWER_MODEL',
  'AFK_MAX_REVIEW_ROUNDS',
  'AFK_CONFLICT_TRIES',
  'AFK_WAIT_FOR_CHECKS',
  'AFK_MERGE_TIMEOUT_SEC',
] as const

const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL[key]
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
})

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

  it('env 覆盖 > config.json > 内置默认', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { model: 'file-model', baseBranch: 'develop' })
    process.env.AFK_MODEL = 'env-model'
    process.env.AFK_MAX_PARALLEL = '7'

    const cfg = loadConfig(cwd)

    expect(cfg.model).toBe('env-model') // env 赢 config.json
    expect(cfg.maxParallel).toBe(7) // env 赢默认（字符串数字已类型化）
    expect(cfg.baseBranch).toBe('develop') // config.json 赢默认
    expect(cfg.thinking).toBe('medium') // 默认
  })

  it('env 空串/空白视为未设置 → 不覆盖', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { model: 'file-model' })
    process.env.AFK_MODEL = '   '

    expect(loadConfig(cwd).model).toBe('file-model')
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

  it('env 数字非法（NaN）→ 报错', () => {
    const cwd = tempCwd()
    writeConfig(cwd, {})
    process.env.AFK_MAX_PARALLEL = 'abc'

    expect(() => loadConfig(cwd)).toThrow(/maxParallel/)
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

    // env 覆盖：布尔 'true'/'false' 转类型，数字转 Number
    process.env.AFK_AUTO_MERGE = 'true'
    process.env.AFK_WAIT_FOR_CHECKS = 'false'
    process.env.AFK_MAX_REVIEW_ROUNDS = '4'
    process.env.AFK_MERGED_LABEL = 'merged'
    process.env.AFK_CONFLICT_TRIES = '3'
    process.env.AFK_MERGE_TIMEOUT_SEC = '900'
    const overridden = loadConfig(cwd)
    expect(overridden.autoMerge).toBe(true)
    expect(overridden.waitForChecks).toBe(false)
    expect(overridden.maxReviewRounds).toBe(4)
    expect(overridden.mergedLabel).toBe('merged')
    expect(overridden.conflictTries).toBe(3)
    expect(overridden.mergeTimeoutSec).toBe(900)
  })

  it('布尔 env 非法值（非 true/false）→ 报错并定位键名', () => {
    const cwd = tempCwd()
    writeConfig(cwd, {})
    process.env.AFK_AUTO_MERGE = 'yes'

    expect(() => loadConfig(cwd)).toThrow(/autoMerge/)
  })

  it('完整流程新键非法值 → 报错并定位键名', () => {
    const cwd = tempCwd()
    writeConfig(cwd, { maxReviewRounds: 0 })
    expect(() => loadConfig(cwd)).toThrow(/maxReviewRounds/)
  })
})
