import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 全局结构化日志（JSON lines），为将来 Web UI 做数据源。
 * 每个事件一行 JSON，方便后续按类型/时间过滤。
 */
export interface LogEntry {
  type: string
  [key: string]: unknown
}

export function appendLog(logDir: string, entry: LogEntry): void {
  try {
    mkdirSync(logDir, { recursive: true })
    appendFileSync(
      join(logDir, 'afk.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
      'utf8',
    )
  } catch {
    // 日志失败不阻塞主流程
  }
}
