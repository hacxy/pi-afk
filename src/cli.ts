import { cac } from 'cac'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, type Config } from './config.js'
import { createGitIdentityResolver, type GitIdentity } from './identity.js'
import { runAfk } from './index.js'
import { runInit, type InitResult } from './init.js'
import { log, logError } from './log.js'

/** 版本号：src/../package.json（dev）== dist/../package.json（build），均指向包根 */
const VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version as string

/** gitignore 维护动作的终端描述 */
const GITIGNORE_DESC: Record<InitResult['gitignore'], string> = {
  created: '已创建 .gitignore 并写入白名单规则',
  appended: '已追加白名单规则（.pi/afk/* + config.json 例外）',
  replaced: '已将旧整体忽略规则改写为白名单（config.json 现在可提交）',
  unchanged: '白名单规则已就位，无需变更',
}

/** Dockerfile 维护动作的终端描述 */
const DOCKERFILE_DESC: Record<InitResult['dockerfile'], string> = {
  created: '已创建 .pi/afk/Dockerfile',
  replaced: '已重写 .pi/afk/Dockerfile（内容变更）',
  unchanged: '.pi/afk/Dockerfile 未变更',
}

/** 无人值守循环（默认命令 action）：拉 issue → 分批并发完整流程 → 汇总 */
export async function runAfkLoop(maxIterations?: string | number, local = false): Promise<void> {
  // 配置启动即校验（.pi/afk/config.json 必须存在）：缺失 → 干净报错 + 提示 afk init，不进 loop
  let config: Config
  try {
    config = loadConfig()
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  // 提交身份启动即校验（拉 issue/建 worktree 前）：缺失 → 干净报错 + exit 1，不进 loop
  let identity: GitIdentity
  try {
    identity = createGitIdentityResolver(config)()
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  // 位置参数解析：默认 1，clamp ≥ 1（0/负数/非数字均按 1）
  const n = maxIterations === undefined || maxIterations === '' ? 1 : Number(maxIterations)
  const limit = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1
  // --local：本次会话临时关闭沙箱（config 持久化 sandbox 仍生效）
  const effective = local ? { ...config, sandbox: false } : config
  log(
    `afk 启动：无人值守循环（${effective.sandbox ? '沙箱容器' : '本地'}完整流程，最大迭代 ${limit}，提交身份 ${identity.name} <${identity.email}>）`,
  )
  const results = await runAfk(effective, limit)

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
      '无人值守循环：拉 agent:todo issue → implementer → push → 开 PR → codereview（≤ maxReviewRounds 轮）→ autoMerge 时串行合并 PR（含冲突化解），迭代 maxIterations 次，每次并发至多 maxParallel 个，默认 1',
    )
    .option('--local', '本地运行（关闭 docker 沙箱；默认 Sandbox 模式）')
    .action(async (maxIterations?: string, options: { local?: boolean } = {}) => {
      try {
        await runAfkLoop(maxIterations, options.local)
      } catch (error) {
        logError(`afk 崩溃：${error instanceof Error ? (error.stack ?? error.message) : error}`)
        process.exitCode = 1
      }
    })

  cli
    .command('init', '初始化 .pi/afk/config.json（含 gitignore 白名单 + 状态机 label 幂等补建）')
    .option('--force', '覆盖已存在的配置为默认值')
    .action(async (options: { force?: boolean }) => {
      try {
        const result = await runInit(process.cwd(), { force: options.force })
        log(`✓ 已生成配置 ${result.configPath}`)
        log(`  baseBranch: ${result.baseBranch}（origin/HEAD 探测，无则回落 main）`)
        log(`  .gitignore: ${GITIGNORE_DESC[result.gitignore]}`)
        log(
          `  Dockerfile: ${DOCKERFILE_DESC[result.dockerfile]}，已构建镜像 ${result.imageTag}（沙箱默认；--local 跳过）`,
        )
        if (result.labelsCreated.length > 0) {
          log(`  labels: 已补建 ${result.labelsCreated.join('、')}`)
        } else {
          log('  labels: 均已存在，无需创建')
        }
        log('提示：秘密（模型 API key / GH_TOKEN）请用环境变量提供，config.json 不含秘密')
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error))
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
