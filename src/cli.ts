import { runAfk } from './index.js'
import { log, logError } from './log.js'

async function main(): Promise<void> {
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

main().catch((error) => {
  logError(`afk 崩溃：${error instanceof Error ? (error.stack ?? error.message) : error}`)
  process.exitCode = 1
})
