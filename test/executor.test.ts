import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HostExecutor,
  JsonlSplitter,
  SessionRecorder,
  Watchdog,
  type StageContext,
  type WatchdogOptions,
  assembleText,
  isSettled,
  normalizeExitCode,
  parseEvent,
  parseSessionHead,
} from '../src/executor.js'

type FakeChild = EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  exit: (code: number | null, signal: NodeJS.Signals | null) => void
}

/** 假子进程：PassThrough 流 + 可控 exit/kill（注入 HostExecutor 的 spawn 工厂） */
function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => child.exit(null, 'SIGTERM'))
  child.exit = (code, signal) => child.emit('exit', code, signal)
  return child
}

const ctx: StageContext = {
  prompt: '测试',
  model: 'm',
  stage: 'implementer',
  branch: 'afk/issue-1-x',
}

describe('parseEvent 事件解析', () => {
  it('解析合法 JSON 行为事件对象', () => {
    const e = parseEvent('{"type":"agent_start"}')
    expect(e).toEqual({ type: 'agent_start' })
  })

  it('非法 JSON 行返回 null（容错杂音）', () => {
    expect(parseEvent('not json')).toBeNull()
    expect(parseEvent('')).toBeNull()
    expect(parseEvent('{"broken"')).toBeNull()
  })
})

describe('assembleText text 还原', () => {
  it('把 text_delta 按顺序拼成完整文本', () => {
    const events = [
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world' },
      },
    ]
    expect(assembleText(events)).toBe('Hello world')
  })

  it('多个内容块按 contentIndex 顺序连接', () => {
    const events = [
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '答案' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '（注）' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '是' },
      },
    ]
    expect(assembleText(events)).toBe('答案是（注）')
  })

  it('忽略非 text_delta 事件', () => {
    const events = [
      { type: 'agent_start' },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '思考' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '正文' },
      },
    ]
    expect(assembleText(events)).toBe('正文')
  })
})

describe('session 头与终态判定', () => {
  it('从 session 头提取 id 和 cwd', () => {
    expect(parseSessionHead({ type: 'session', id: 'abc-123', cwd: '/x' })).toEqual({
      id: 'abc-123',
      cwd: '/x',
    })
  })

  it('非 session 头返回 null', () => {
    expect(parseSessionHead({ type: 'agent_start' })).toBeNull()
  })

  it('agent_settled 是终态', () => {
    expect(isSettled({ type: 'agent_settled' })).toBe(true)
  })

  it('agent_end 且 willRetry=false 是终态', () => {
    expect(isSettled({ type: 'agent_end', messages: [], willRetry: false })).toBe(true)
  })

  it('agent_end 且 willRetry=true 不是终态（pi 要自动重试）', () => {
    expect(isSettled({ type: 'agent_end', messages: [], willRetry: true })).toBe(false)
  })

  it('其他事件不是终态', () => {
    expect(isSettled({ type: 'turn_end' })).toBe(false)
  })
})

describe('normalizeExitCode 退出码归一', () => {
  it('正常数字退出码透传', () => {
    expect(normalizeExitCode(0, null)).toBe(0)
    expect(normalizeExitCode(2, null)).toBe(2)
  })

  it('被信号杀死时归一为 128+信号号', () => {
    expect(normalizeExitCode(null, 'SIGTERM')).toBe(143) // 128 + 15
    expect(normalizeExitCode(null, 'SIGKILL')).toBe(137) // 128 + 9
  })

  it('无退出码也无信号（异常）归一为 1', () => {
    expect(normalizeExitCode(null, null)).toBe(1)
  })
})

describe('Watchdog 双超时监守', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeWatchdog(overrides: Partial<WatchdogOptions> = {}) {
    const onTimeout = vi.fn()
    const watchdog = new Watchdog({ idleMs: 100, completionMs: 50, onTimeout, ...overrides })
    return { watchdog, onTimeout }
  }

  it('idle 超时：idleMs 无活动即判超时', () => {
    const { watchdog, onTimeout } = makeWatchdog()
    vi.advanceTimersByTime(99)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    void watchdog
  })

  it('活动重置 idle 计时', () => {
    const { watchdog, onTimeout } = makeWatchdog()
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(90)
      watchdog.activity()
    }
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('终态后 idle 失效，转 completion 宽限', () => {
    const { watchdog, onTimeout } = makeWatchdog({ completionMs: 1000 })
    watchdog.activity()
    watchdog.settled()
    vi.advanceTimersByTime(500) // 超过 idleMs(100) 但未到 completionMs(1000)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('completion 超时：终态后宽限到期判超时', () => {
    const { watchdog, onTimeout } = makeWatchdog()
    watchdog.activity()
    watchdog.settled()
    vi.advanceTimersByTime(49)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('终态后的活动重置 completion 宽限', () => {
    const { watchdog, onTimeout } = makeWatchdog()
    watchdog.activity()
    watchdog.settled()
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(45)
      watchdog.activity()
    }
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('stop 后不再触发超时', () => {
    const { watchdog, onTimeout } = makeWatchdog()
    watchdog.activity()
    watchdog.stop()
    vi.advanceTimersByTime(1000)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('超时只触发一次', () => {
    const { watchdog, onTimeout } = makeWatchdog()
    vi.advanceTimersByTime(200)
    vi.advanceTimersByTime(200)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    void watchdog
  })
})

describe('SessionRecorder 会话落盘', () => {
  it('原样落盘 JSONL 行（含 session 头，可 grep）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'afk-sess-'))
    const file = join(dir, 'sess.jsonl')
    const rec = new SessionRecorder(file)
    rec.write('{"type":"session","id":"abc-123"}')
    rec.write('{"type":"agent_start"}')
    rec.write('{"type":"agent_settled"}')

    const content = readFileSync(file, 'utf8')
    expect(content).toContain('"id":"abc-123"') // session id 可 grep
    expect(content.split('\n').filter(Boolean)).toEqual([
      '{"type":"session","id":"abc-123"}',
      '{"type":"agent_start"}',
      '{"type":"agent_settled"}',
    ])
  })

  it('自动创建父目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'afk-sess-'))
    const file = join(dir, 'nested', 'deep', 'sess.jsonl')
    const rec = new SessionRecorder(file)
    rec.write('{"type":"session","id":"x"}')
    expect(existsSync(file)).toBe(true)
  })
})

describe('HostExecutor 宿主后端（假 spawn）', () => {
  function makeExecutor(overrides: { idleMs?: number; completionMs?: number } = {}) {
    const child = makeFakeChild()
    const sessionDir = mkdtempSync(join(tmpdir(), 'afk-host-'))
    const executor = new HostExecutor({
      spawnFn: () => child,
      idleMs: overrides.idleMs ?? 1000,
      completionMs: overrides.completionMs ?? 500,
      sessionDir,
    })
    return { executor, child, sessionDir }
  }

  it('端到端：事件流 → 退出码/sessionId/text 还原/onText/落盘', async () => {
    const { executor, child, sessionDir } = makeExecutor()
    const onText = vi.fn()
    const onEvent = vi.fn()

    const promise = executor.runStage(ctx, { onText, onEvent })
    child.stdout.write('{"type":"session","id":"s1","cwd":"/x"}\n')
    child.stdout.write('{"type":"agent_start"}\n')
    child.stdout.write(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"你好"}}\n',
    )
    child.stdout.write(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"世界"}}\n',
    )
    child.stdout.write('{"type":"agent_settled"}\n')
    child.stdout.end()
    child.exit(0, null)

    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.sessionId).toBe('s1')
    expect(result.stdout).toBe('你好世界')
    expect(result.timedOut).toBe(false)
    expect(onText).toHaveBeenCalledWith('你好')
    expect(onText).toHaveBeenCalledWith('世界')
    expect(onEvent).toHaveBeenCalled()

    // 落盘可 grep（含 session id）；分支名斜杠替换为 _
    const files = readFileSync(join(sessionDir, 'afk_issue-1-x-implementer.jsonl'), 'utf8')
    expect(files).toContain('"id":"s1"')
    expect(files).toContain('"type":"agent_settled"')
  })

  it('非零退出码透传', async () => {
    const { executor, child } = makeExecutor()
    const promise = executor.runStage(ctx)
    child.stdout.write('{"type":"session","id":"s2"}\n')
    child.stdout.end()
    child.exit(2, null)
    const result = await promise
    expect(result.exitCode).toBe(2)
  })

  it('idle 超时：无活动 → kill + timedOut + 信号退出码', async () => {
    vi.useFakeTimers()
    try {
      const { executor, child } = makeExecutor({ idleMs: 100, completionMs: 50 })
      const promise = executor.runStage(ctx)
      child.stdout.write('{"type":"session","id":"s3"}\n')

      await vi.advanceTimersByTimeAsync(100) // idleMs 到期

      const result = await promise
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(143) // SIGTERM → 128+15
    } finally {
      vi.useRealTimers()
    }
  })

  it('终态后 idle 失效：completion 宽限到期才判超时', async () => {
    vi.useFakeTimers()
    try {
      const { executor, child } = makeExecutor({ idleMs: 100, completionMs: 50 })
      const promise = executor.runStage(ctx)
      child.stdout.write('{"type":"session","id":"s4"}\n')
      child.stdout.write('{"type":"agent_settled"}\n')

      await vi.advanceTimersByTimeAsync(200) // 超过 idleMs(100)，未到 completionMs(50) 之后

      const result = await promise
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(result.timedOut).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('spawn 失败（如 pi 不存在）→ 退出码 1', async () => {
    const errChild = new EventEmitter() as unknown as FakeChild
    errChild.stdout = new PassThrough()
    errChild.stderr = new PassThrough()
    errChild.kill = vi.fn()
    const executor = new HostExecutor({
      spawnFn: () => errChild,
      idleMs: 1000,
      completionMs: 500,
      sessionDir: mkdtempSync(join(tmpdir(), 'afk-host-')),
    })

    const promise = executor.runStage(ctx)
    errChild.emit('error', new Error('ENOENT'))
    const result = await promise
    expect(result.exitCode).toBe(1)
    expect(result.timedOut).toBe(false)
  })

  it('stderr 清洗 ANSI 控制序列（pi 启动时发 TUI 清屏码）', async () => {
    const { executor, child } = makeExecutor()
    const promise = executor.runStage(ctx)
    child.stdout.write('{"type":"session","id":"s5"}\n')
    child.stdout.end()
    child.stderr.write('\u001b[2J\u001b[3J\u001b[H真实错误\n')
    child.stderr.end()
    child.exit(1, null)
    const result = await promise
    expect(result.stderr).toBe('真实错误\n')
  })
})

describe('JsonlSplitter 分帧', () => {
  it('按换行切分完整行', () => {
    const splitter = new JsonlSplitter()
    expect(splitter.feed('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('跨 chunk 的半行累积到下一块', () => {
    const splitter = new JsonlSplitter()
    expect(splitter.feed('{"a":')).toEqual([])
    expect(splitter.feed('1}\n{"b":')).toEqual(['{"a":1}'])
    expect(splitter.feed('2}\n')).toEqual(['{"b":2}'])
  })

  it('兼容 CRLF 行尾', () => {
    const splitter = new JsonlSplitter()
    expect(splitter.feed('{"a":1}\r\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('跳过空行', () => {
    const splitter = new JsonlSplitter()
    expect(splitter.feed('\n{"a":1}\n\n')).toEqual(['{"a":1}'])
  })

  it('flush 取出无换行结尾的残留行', () => {
    const splitter = new JsonlSplitter()
    expect(splitter.feed('{"a":1}\n{"b":')).toEqual(['{"a":1}'])
    expect(splitter.flush()).toEqual(['{"b":'])
    expect(splitter.flush()).toEqual([])
  })
})
