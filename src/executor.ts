/**
 * 共享执行层：Executor 接口 + `--mode json` 事件流处理。
 *
 * 所有后端（宿主 spawn pi / 容器 docker exec）共用的纯逻辑：
 * JSONL 分帧、事件解析、text 还原、退出码归一、双超时监守、会话落盘。
 * 后端只是薄的 spawn 命令，事件从这里流式消费。
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'

import { config } from './config.js'

/** 事件对象：pi `--mode json` 事件流的一行（透传，只按需取字段） */
export interface PiEvent {
  type: string
  [key: string]: unknown
}

/** 解析单行 JSON。非 JSON / 空行返回 null（容错杂音）。 */
export function parseEvent(line: string): PiEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown
    return parsed && typeof parsed === 'object' && 'type' in (parsed as object)
      ? (parsed as PiEvent)
      : null
  } catch {
    return null
  }
}

/** session 头：`--mode json` 第一行，含会话 id。 */
export interface SessionHead {
  id: string
  cwd?: string
}

/** 从事件里提取 session 头信息（仅 type==='session' 的事件）。 */
export function parseSessionHead(event: PiEvent): SessionHead | null {
  if (event.type !== 'session') return null
  const id = (event as { id?: unknown }).id
  const cwd = (event as { cwd?: unknown }).cwd
  if (typeof id !== 'string') return null
  return { id, cwd: typeof cwd === 'string' ? cwd : undefined }
}

/**
 * 终态判定：agent_settled，或 agent_end 且 willRetry=false。
 * willRetry=true 时 pi 会自动重试，agent_end 不是最终态。
 */
export function isSettled(event: PiEvent): boolean {
  if (event.type === 'agent_settled') return true
  if (event.type === 'agent_end') {
    return (event as { willRetry?: unknown }).willRetry === false
  }
  return false
}

/**
 * 退出码归一：数字透传；信号 → 128+信号号；两者皆无（异常）→ 1。
 * 用途：spawn 失败 / 被杀 / 正常退出统一成 shell 惯例退出码。
 */
export function normalizeExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code
  if (signal) {
    const num = signalNumber(signal)
    if (num !== undefined) return 128 + num
  }
  return 1
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  // 运行时 Object.entries 的键恒为字符串；TS 类型却是数字键，cast 对齐真实形态
  const entries = Object.entries(os.constants.signals) as [string, string | number][]
  // 平台差异：macOS 是 { SIGTERM: 15 }，Linux 是 { '15': 'SIGTERM' }——双向查找
  const byName = entries.find(([k, v]) => k === signal || v === signal)
  if (!byName) return undefined
  const num = Number(byName[1] ?? byName[0])
  return Number.isNaN(num) ? undefined : num
}

/**
 * 会话落盘（A13）：`--mode json` 事件流原样逐行 append，含 session 头。
 * 完整、可 grep、含 session id。
 */
export class SessionRecorder {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true })
  }

  /** 原样写一行（自动补 \n） */
  write(rawLine: string): void {
    appendFileSync(this.file, rawLine + '\n')
  }

  /** 文件路径（观测用） */
  get path(): string {
    return this.file
  }
}

/**
 * 双超时监守（A9）：
 * - idle：任何事件/输出到达时重置；idleMs 无活动 → 判超时（kill 子进程）
 * - completion：终态事件（agent_settled / agent_end）到达后转入宽限；completionMs 内无活动且进程未退 → 判超时
 * - 判超时只触发一次，之后 stop() 清场
 */
export interface WatchdogOptions {
  idleMs: number
  completionMs: number
  onTimeout: () => void
}

export class Watchdog {
  private idleTimer?: ReturnType<typeof setTimeout>
  private completionTimer?: ReturnType<typeof setTimeout>
  private done = false

  constructor(private readonly opts: WatchdogOptions) {
    this.resetIdle()
  }

  /** 任何事件/输出到达时调用：未终态时重置 idle；终态后重置 completion 宽限 */
  activity(): void {
    if (this.done) return
    if (this.completionTimer) {
      clearTimeout(this.completionTimer)
      this.completionTimer = setTimeout(() => this.fire(), this.opts.completionMs)
    } else {
      this.resetIdle()
    }
  }

  /** 终态事件（agent_settled / agent_end）到达时调用：停 idle，转 completion 宽限 */
  settled(): void {
    if (this.done) return
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    if (this.completionTimer) return
    this.completionTimer = setTimeout(() => this.fire(), this.opts.completionMs)
  }

  /** 进程正常退出时调用：清理全部计时器 */
  stop(): void {
    this.done = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.completionTimer) clearTimeout(this.completionTimer)
  }

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.fire(), this.opts.idleMs)
  }

  private fire(): void {
    if (this.done) return
    this.done = true
    this.opts.onTimeout()
  }
}

/** 把事件流还原成完整 assistant 文本：text_delta 按 contentIndex 分桶、按索引序连接。 */
export function assembleText(events: PiEvent[]): string {
  const buckets = new Map<number, string>()
  for (const e of events) {
    if (e.type !== 'message_update') continue
    const inner = (
      e as { assistantMessageEvent?: { type?: string; contentIndex?: number; delta?: string } }
    ).assistantMessageEvent
    if (!inner || inner.type !== 'text_delta' || typeof inner.delta !== 'string') continue
    const idx = typeof inner.contentIndex === 'number' ? inner.contentIndex : 0
    buckets.set(idx, (buckets.get(idx) ?? '') + inner.delta)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text)
    .join('')
}

/** 清洗 ANSI 转义序列（pi 启动时向 stderr 发 TUI 清屏码，如 \u001b[2J）。 */
// eslint-disable-next-line no-control-regex -- 需要匹配控制字符
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()][A-Z0-9]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/**
 * JSONL 分帧器（有状态）：把流式 chunk 切成完整行。
 * - 行以 \n 结束，兼容 \r\n
 * - 空行跳过（pi 事件流不应有空行，容错）
 * - 跨 chunk 的半行累积到下一块
 * - 流结束时调用 flush() 取残留（无换行结尾的最后一行）
 */
export class JsonlSplitter {
  private buffer = ''

  feed(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > 0) lines.push(line)
    }
    return lines
  }

  flush(): string[] {
    if (this.buffer.length === 0) return []
    const line = this.buffer
    this.buffer = ''
    return [line]
  }
}

/** 阶段上下文：Executor「跑一个阶段」的输入（A6）。 */
export interface StageContext {
  prompt: string
  model: string
  stage: string
  branch: string
  /** 目标项目 worktree 宿主路径（容器后端用；宿主后端忽略） */
  worktree?: string
}

export interface StageResult {
  exitCode: number
  sessionId?: string
  /** agent 完整回复文本（text_delta 还原），非原始 JSONL */
  stdout: string
  stderr: string
  /** 是否因 idle/completion 超时被杀（A9） */
  timedOut: boolean
  /** 会话 JSONL 落盘路径 */
  sessionFile: string
}

export interface ExecutorHooks {
  /** 每个解析后的事件（透传，观测用） */
  onEvent?: (event: PiEvent) => void
  /** text_delta 增量（实时渲染用） */
  onText?: (delta: string) => void
}

/** Executor：「跑一个阶段」的最小抽象。后端只是薄的 spawn 命令，共享层消费事件。 */
export interface Executor {
  runStage(ctx: StageContext, hooks?: ExecutorHooks): Promise<StageResult>
}

/** spawn 工厂：默认 node:child_process spawn，测试注入假子进程 */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export interface HostExecutorOptions {
  spawnFn?: SpawnFn
  idleMs?: number
  completionMs?: number
  sessionDir?: string
}

/**
 * 宿主后端：spawn `pi -p --mode json`，流式消费事件。
 * - 每行 JSONL 原样落盘 .afk/sessions/<branch>-<stage>.jsonl（A13）
 * - 终态判定 agent_settled / agent_end(willRetry=false)（A9）
 * - 双超时：idle 无活动 / completion 宽限到期 → kill + timedOut
 * - 退出码归一（正常 / 信号 / spawn 失败）
 */
export class HostExecutor implements Executor {
  private readonly spawnFn: SpawnFn
  private readonly idleMs: number
  private readonly completionMs: number
  private readonly sessionDir: string

  constructor(opts: HostExecutorOptions = {}) {
    this.spawnFn = opts.spawnFn ?? spawn
    this.idleMs = opts.idleMs ?? config.idleTimeoutSec * 1000
    this.completionMs = opts.completionMs ?? config.completionTimeoutSec * 1000
    this.sessionDir = opts.sessionDir ?? config.sessionsDir
  }

  runStage(ctx: StageContext, hooks?: ExecutorHooks): Promise<StageResult> {
    const safeBranch = ctx.branch.replaceAll('/', '_')
    const recorder = new SessionRecorder(join(this.sessionDir, `${safeBranch}-${ctx.stage}.jsonl`))
    const events: PiEvent[] = []
    let sessionId: string | undefined
    let timedOut = false
    let settled = false

    return new Promise((resolvePromise) => {
      const child = this.spawnFn(
        'pi',
        ['-p', '--mode', 'json', '--model', ctx.model, '--thinking', config.thinking, ctx.prompt],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )

      const finish = (exitCode: number, stderr: string): void => {
        if (settled) return
        settled = true
        watchdog.stop()
        resolvePromise({
          exitCode,
          sessionId,
          stdout: assembleText(events),
          stderr,
          timedOut,
          sessionFile: recorder.path,
        })
      }

      const watchdog = new Watchdog({
        idleMs: this.idleMs,
        completionMs: this.completionMs,
        onTimeout: () => {
          timedOut = true
          try {
            child.kill('SIGTERM')
          } catch {
            // 进程可能已退出
          }
        },
      })

      const handleLine = (line: string): void => {
        recorder.write(line)
        const event = parseEvent(line)
        if (!event) return
        events.push(event)
        hooks?.onEvent?.(event)
        const head = parseSessionHead(event)
        if (head) sessionId = head.id
        if (event.type === 'message_update') {
          const inner = (
            event as {
              assistantMessageEvent?: { type?: string; delta?: string }
            }
          ).assistantMessageEvent
          if (inner?.type === 'text_delta' && typeof inner.delta === 'string') {
            hooks?.onText?.(inner.delta)
          }
        }
        if (isSettled(event)) watchdog.settled()
      }

      const splitter = new JsonlSplitter()
      let stderrBuf = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        watchdog.activity()
        for (const line of splitter.feed(chunk.toString('utf8'))) handleLine(line)
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        watchdog.activity()
        stderrBuf += stripAnsi(chunk.toString('utf8'))
      })

      child.on('error', (err) => {
        // spawn 失败（如 pi 不存在）→ 归一退出码 1
        finish(1, stderrBuf || String(err))
      })

      child.on('exit', (code, signal) => {
        watchdog.activity()
        for (const line of splitter.flush()) handleLine(line)
        finish(normalizeExitCode(code, signal), stderrBuf)
      })
    })
  }
}
