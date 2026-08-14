import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { config } from './config.js'

let logFile: string | undefined

/** 主循环日志文件（每轮一个，按时间戳） */
function ensureLogFile(): string | undefined {
  if (logFile) return logFile
  try {
    const dir = resolve(config.logsDir)
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    logFile = resolve(dir, `afk-${stamp}.log`)
    return logFile
  } catch {
    return undefined
  }
}

export function log(msg: string): void {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`
  // eslint-disable-next-line no-console -- 主日志输出，日志模块本身职责
  console.log(line)
  const f = ensureLogFile()
  if (f) appendFileSync(f, line + '\n')
}

export function logError(msg: string): void {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ✗ ${msg}`
  console.error(line)
  const f = ensureLogFile()
  if (f) appendFileSync(f, line + '\n')
}
