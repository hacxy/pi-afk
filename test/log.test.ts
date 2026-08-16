import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { beginIssueLog, log, logError } from '../src/log.js'

/** 测试用 logsDir（真实临时目录，行为贴近生产：落盘 + 读取） */
const cfg = vi.hoisted(() => ({ logsDir: '' }))

vi.mock('../src/config.js', () => ({
  config: {
    get logsDir() {
      return cfg.logsDir
    },
  },
}))

let logFile: string

beforeEach(() => {
  cfg.logsDir = mkdtempSync(join(tmpdir(), 'afk-log-test-'))
  logFile = join(cfg.logsDir, 'issue-12.log')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cfg.logsDir, { recursive: true, force: true })
})

describe('logAgent 行缓冲（agent 正文增量落盘）', () => {
  it('跨 chunk 的半行先缓冲，凑成完整行才写入（不产生中间碎片行）', () => {
    const logger = beginIssueLog(12)
    logger.logAgent('hello ')
    expect(readFileSync(logFile, 'utf8')).toBe('')

    logger.logAgent('wor')
    expect(readFileSync(logFile, 'utf8')).toBe('')

    logger.logAgent('ld\n')
    expect(readFileSync(logFile, 'utf8')).toBe('hello world\n')
  })

  it('flushAgent 冲刷无换行结尾的残留半行（补 \n 保证后续 append 从新行开始），且幂等（二次调用无副作用）', () => {
    const logger = beginIssueLog(12)
    logger.logAgent('first\nsecond')
    expect(readFileSync(logFile, 'utf8')).toBe('first\n')

    logger.flushAgent()
    expect(readFileSync(logFile, 'utf8')).toBe('first\nsecond\n')

    logger.flushAgent()
    expect(readFileSync(logFile, 'utf8')).toBe('first\nsecond\n')
  })

  it('空行不写入（\n 之间的空段跳过，与生命周期日志行为一致）', () => {
    const logger = beginIssueLog(12)
    logger.logAgent('a\n\nb\n')
    expect(readFileSync(logFile, 'utf8')).toBe('a\nb\n')
  })
})

describe('前缀结构化（归属从消息文本约定升级为结构保证）', () => {
  it('issue 级日志统一 [时间] [#N] 前缀，错误带 ✗', () => {
    const logger = beginIssueLog(12)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logger.log('开始')
    logger.logError('失败')
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[\d{1,2}:\d{2}:\d{2}\] \[#12\] 开始$/),
    )
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[\d{1,2}:\d{2}:\d{2}\] \[#12\] ✗ 失败$/),
    )
  })

  it('运行级日志带 [afk] 标记，与 issue 级层级分明', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    log('afk 启动')
    logError('崩溃')
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[\d{1,2}:\d{2}:\d{2}\] \[afk\] afk 启动$/),
    )
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[\d{1,2}:\d{2}:\d{2}\] \[afk\] ✗ 崩溃$/),
    )
  })

  it('issue 级日志也落盘到对应文件，正文与生命周期混排同文件', () => {
    const logger = beginIssueLog(12)
    logger.log('开始')
    logger.logAgent('agent 第一行\n')
    const content = readFileSync(logFile, 'utf8')
    expect(content).toContain('[#12] 开始')
    expect(content).toContain('agent 第一行')
  })
})
