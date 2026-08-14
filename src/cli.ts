import { cac } from 'cac'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runAfk } from './index.js'
import { log, logError } from './log.js'

/** 版本号：src/../package.json（dev）== dist/../package.json（build），均指向包根 */
const VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version as string

/** 无人值守循环（默认命令 action）：拉 issue → 分批并发完整流程 → 汇总 */
export async function runAfkLoop(maxIterations?: string | number): Promise<void> {
  // 位置参数解析：默认 1，clamp ≥ 1（0/负数/非数字均按 1）
  const n = maxIterations === undefined || maxIterations === '' ? 1 : Number(maxIterations)
  const limit = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1
  log(`afk 启动：无人值守循环（本地 worktree 完整流程，最大迭代 ${limit}）`)
  const results = await runAfk(limit)

  const done = results.filter((r) => r.status === 'done')
  const failed = results.filter((r) => r.status === 'failed')

  log('\n━━━━━━ 汇总 ━━━━━━')
  for (const r of done) log(`  ✓ #${r.issue.number} ${r.issue.title}`)
  for (const r of failed)
    logError(`  ✗ #${r.issue.number} ${r.issue.title} — ${r.error ?? '未知错误'}`)
  log(`\n${done.length}/${results.length} 成功`)

  process.exitCode = failed.length > 0 ? 1 : 0
}

function main(): void {
  const cli = cac('afk')

  cli
    .command(
      '[maxIterations]',
      '无人值守循环：拉 agent:todo issue → 宿主单阶段 implementer → push → 开 PR（迭代 maxIterations 次，每次并发处理至多 maxParallel 个，默认 1）',
    )
    .action(async (maxIterations?: string) => {
      try {
        await runAfkLoop(maxIterations)
      } catch (error) {
        logError(`afk 崩溃：${error instanceof Error ? (error.stack ?? error.message) : error}`)
        process.exitCode = 1
      }
    })

  cli.help()
  cli.version(VERSION)

  cli.parse()
}

// 仅作为 CLI 入口执行时跑 main()（vitest import 测试时不触发 parse）
const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) main()
