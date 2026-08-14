import { config } from './config.js'
import { HostExecutor } from './executor.js'
import { runAfk } from './index.js'
import { log, logError } from './log.js'

export type CliCommand = 'loop' | 'run' | 'help'

export interface CliArgs {
  command: CliCommand | 'error'
  prompt?: string
  error?: string
}

/** 参数解析：无参数 → 无人值守循环；run "<prompt>" → 即席命令；help/未知 → 提示 */
export function parseCliArgs(argv: string[]): CliArgs {
  const [sub, ...rest] = argv
  if (sub === 'run') {
    const prompt = rest.join(' ').trim()
    if (!prompt)
      return { command: 'error', error: 'afk run 需要 prompt（如：afk run "修复登录页 bug"）' }
    return { command: 'run', prompt }
  }
  if (!sub) return { command: 'loop' }
  if (sub === 'help' || sub === '-h' || sub === '--help') {
    return { command: 'help' }
  }
  return { command: 'error', error: `未知命令: ${sub}` }
}

function usage(): void {
  log(`用法:
  afk                    无人值守循环（拉 issue → planner/implementer/reviewer 容器 → push 分支）
  afk run "<prompt>"     宿主本地即席跑一个 pi 会话（实时透传 + 落盘 .afk/sessions/）
  afk --help             显示本帮助`)
}

/** 即席命令：宿主本地单会话 pi（D3），实时透传，退出码透传 */
async function runAdhoc(prompt: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const branch = `run-${stamp}`
  const executor = new HostExecutor()
  log(`afk run：${prompt}`)
  const result = await executor.runStage(
    { prompt, model: config.model, stage: 'adhoc', branch },
    { onText: (delta) => process.stdout.write(delta) },
  )
  // agent 文本可能不以换行结尾，补一个避免粘住后续日志
  if (result.stdout && !result.stdout.endsWith('\n')) process.stdout.write('\n')
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.timedOut) logError('会话超时被杀（idle/completion 超时）')
  if (result.exitCode !== 0)
    logError(`pi 退出码 ${result.exitCode}（session ${result.sessionId ?? '-'}）`)
  log(`会话记录: ${result.sessionFile}`)
  process.exitCode = result.exitCode
}

/** 无人值守循环（原 cli 入口） */
async function runAfkLoop(): Promise<void> {
  log('afk 启动：无人值守循环（最小版 sandcastle）')
  const results = await runAfk()

  const done = results.filter((r) => r.status === 'done')
  const failed = results.filter((r) => r.status === 'failed')

  log('\n━━━━━━ 汇总 ━━━━━━')
  for (const r of done) log(`  ✓ #${r.issue.number} ${r.issue.title}`)
  for (const r of failed)
    logError(`  ✗ #${r.issue.number} ${r.issue.title} — ${r.error ?? '未知错误'}`)
  log(`\n${done.length}/${results.length} 成功`)

  process.exitCode = failed.length > 0 ? 1 : 0
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))
  switch (args.command) {
    case 'run':
      await runAdhoc(args.prompt as string)
      break
    case 'help':
      usage()
      break
    case 'error':
      logError(args.error as string)
      usage()
      process.exitCode = 2
      break
    case 'loop':
      await runAfkLoop()
      break
  }
}

main().catch((error) => {
  logError(`afk 崩溃：${error instanceof Error ? (error.stack ?? error.message) : error}`)
  process.exitCode = 1
})
