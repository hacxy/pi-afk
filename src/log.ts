import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** issue 级日志器：追加写入 .pi/afk/logs/issue-<编号>.log，同时透传终端。 */
export interface IssueLogger {
  log(msg: string): void
  logError(msg: string): void
  /** agent 正文增量（delta 碎片，行缓冲后落盘，不进终端） */
  logAgent(chunk: string): void
  /** 阶段结束冲刷残留半行 */
  flushAgent(): void
  /** 日志文件绝对路径（失败 comment 产物路径用） */
  file: string
}

const stamp = () => new Date().toLocaleTimeString('zh-CN')

/** 运行级日志（仅终端，不落盘）：启动 / 汇总 / 崩溃 / 拉取失败，[afk] 标记区分层级 */
export function log(msg: string): void {
  // eslint-disable-next-line no-console -- 主日志输出，日志模块本身职责
  console.log(`[${stamp()}] [afk] ${msg}`)
}

export function logError(msg: string): void {
  console.error(`[${stamp()}] [afk] ✗ ${msg}`)
}

/**
 * 开始一个 issue 的日志：truncate `<logsDir>/issue-<编号>.log`（跨 run 覆盖写，
 * 文件始终反映最近一次处理；一次运行内同一 issue 只处理一次，无同 run 冲突）。
 * 返回追加写该文件并透传终端的日志器；落盘失败时降级为纯终端，不阻塞编排。
 */
export function beginIssueLog(number: number, logsDir: string): IssueLogger {
  const file = resolve(logsDir, `issue-${number}.log`)
  let agentBuf = ''
  const logger: IssueLogger = {
    file,
    log(msg) {
      const line = `[${stamp()}] [#${number}] ${msg}`
      // eslint-disable-next-line no-console -- 主日志输出，日志模块本身职责
      console.log(line)
      append(file, line)
    },
    logError(msg) {
      const line = `[${stamp()}] [#${number}] ✗ ${msg}`
      console.error(line)
      append(file, line)
    },
    logAgent(chunk) {
      agentBuf += chunk
      let idx: number
      while ((idx = agentBuf.indexOf('\n')) !== -1) {
        const line = agentBuf.slice(0, idx)
        agentBuf = agentBuf.slice(idx + 1)
        if (line.length > 0) append(file, line)
      }
    },
    flushAgent() {
      if (agentBuf.length > 0) {
        append(file, agentBuf)
        agentBuf = ''
      }
    },
  }
  try {
    mkdirSync(resolve(logsDir), { recursive: true })
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
