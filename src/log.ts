import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { config } from './config.js'

/** issue 级日志器：追加写入 .pi/afk/logs/issue-<编号>.log，同时透传终端。 */
export interface IssueLogger {
  log(msg: string): void
  logError(msg: string): void
  /** 日志文件绝对路径（失败 comment 产物路径用） */
  file: string
}

const stamp = () => new Date().toLocaleTimeString('zh-CN')

/** 运行级日志（仅终端，不落盘）：启动 / 汇总 / 崩溃 / 拉取失败 */
export function log(msg: string): void {
  // eslint-disable-next-line no-console -- 主日志输出，日志模块本身职责
  console.log(`[${stamp()}] ${msg}`)
}

export function logError(msg: string): void {
  console.error(`[${stamp()}] ✗ ${msg}`)
}

/**
 * 开始一个 issue 的日志：truncate `.pi/afk/logs/issue-<编号>.log`（跨 run 覆盖写，
 * 文件始终反映最近一次处理；一次运行内同一 issue 只处理一次，无同 run 冲突）。
 * 返回追加写该文件并透传终端的日志器；落盘失败时降级为纯终端，不阻塞编排。
 */
export function beginIssueLog(number: number): IssueLogger {
  const file = resolve(config.logsDir, `issue-${number}.log`)
  const logger: IssueLogger = {
    file,
    log(msg) {
      const line = `[${stamp()}] ${msg}`
      // eslint-disable-next-line no-console -- 主日志输出，日志模块本身职责
      console.log(line)
      append(file, line)
    },
    logError(msg) {
      const line = `[${stamp()}] ✗ ${msg}`
      console.error(line)
      append(file, line)
    },
  }
  try {
    mkdirSync(resolve(config.logsDir), { recursive: true })
    writeFileSync(file, '')
  } catch {
    // 落盘失败：日志器仍可用，只打终端
  }
  return logger
}

function append(file: string, line: string): void {
  try {
    appendFileSync(file, line + '\n')
  } catch {
    // 落盘失败不阻塞主流程
  }
}
