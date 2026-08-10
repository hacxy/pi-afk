/* eslint-disable no-console */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import {
  loadGlobalConfig,
  loadProjectConfig,
  globalConfigPath,
  DEFAULT_GLOBAL_CONFIG,
  ensureGlobalDirs,
} from './config.js'
import { requireDeepseekKey } from './credentials.js'
import { appendLog } from './log.js'
import { runAfkLoop, type LoopEvent } from './loop.js'

const USAGE = `pi-afk —— 基于 sandcastle 的 AFK 循环编排器

用法:
  afk <迭代次数>        在当前项目目录运行 AFK 循环（处理带 label 的开放 issue）
  afk init              初始化：构建沙箱镜像、生成全局配置、检查凭据
  afk --help            显示帮助

环境变量:
  DEEPSEEK_API_KEY      deepseek API key（必填）
  GH_TOKEN              GitHub token（可选，未设置时用宿主 gh 登录凭据）

配置:
  全局: ~/.afk/config.json
  项目: ./.afkrc.json（可选，可覆盖 label / maxIterations）
`

// ---------------------------------------------------------------------------
// afk init
// ---------------------------------------------------------------------------

function dockerfilePath(): string {
  // tsup 打包后本文件在 <pkg>/dist/，Dockerfile 在包根
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', 'Dockerfile')
}

function ensureGlobalConfig(): void {
  const file = globalConfigPath()
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(DEFAULT_GLOBAL_CONFIG, null, 2) + '\n', 'utf8')
    console.log(`✓ 已生成全局配置: ${file}`)
  }
}

async function initCmd(projectDir: string): Promise<void> {
  const cfg = loadGlobalConfig()

  // 1. 全局配置
  ensureGlobalConfig()
  ensureGlobalDirs()

  // 2. deepseek key
  try {
    requireDeepseekKey()
    console.log('✓ DEEPSEEK_API_KEY 已设置')
  } catch (err) {
    console.warn(`⚠ ${(err as Error).message}`)
  }

  // 3. gh 登录
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' })
    console.log('✓ gh 已登录')
  } catch {
    console.warn('⚠ gh 未登录，issue 拉取/推送需要 `gh auth login`')
  }

  // 4. 镜像（存在则跳过，否则构建）
  try {
    execFileSync('docker', ['image', 'inspect', cfg.image], { stdio: 'ignore' })
    console.log(`✓ 沙箱镜像已存在: ${cfg.image}`)
  } catch {
    console.log(`→ 构建沙箱镜像 ${cfg.image}（首次约 1-2 分钟）...`)
    const dockerfile = dockerfilePath()
    const uid = process.getuid?.() ?? 1000
    const gid = process.getgid?.() ?? 1000
    try {
      execFileSync(
        'docker',
        [
          'build',
          '-t',
          cfg.image,
          '--build-arg',
          `AGENT_UID=${uid}`,
          '--build-arg',
          `AGENT_GID=${gid}`,
          '-f',
          dockerfile,
          dirname(dockerfile),
        ],
        { stdio: 'inherit' },
      )
      console.log(`✓ 镜像构建完成: ${cfg.image}`)
    } catch {
      console.error('✗ 镜像构建失败，请检查 docker 是否在运行（OrbStack）')
      process.exitCode = 1
      return
    }
  }

  // 5. 项目 .gitignore 增加 .sandcastle/
  const gitignore = join(projectDir, '.gitignore')
  if (existsSync(gitignore)) {
    const content = readFileSync(gitignore, 'utf8')
    if (!content.includes('.sandcastle/')) {
      appendFileSync(gitignore, '\n# pi-afk 运行时工作区\n.sandcastle/\n', 'utf8')
      console.log('✓ 已向 .gitignore 追加 .sandcastle/')
    }
  } else {
    writeFileSync(gitignore, '.sandcastle/\n', 'utf8')
    console.log('✓ 已创建 .gitignore（含 .sandcastle/）')
  }

  console.log('\n初始化完成。现在可以运行: afk 10')
}

// ---------------------------------------------------------------------------
// 事件打印
// ---------------------------------------------------------------------------

function printEvents(events: LoopEvent[]): void {
  for (const e of events) {
    switch (e.type) {
      case 'iteration-start':
        console.log(`\n[${e.iteration}/${e.total}] ----------`)
        break
      case 'issue-picked':
        console.log(`→ 处理 issue #${e.issue.number}: ${e.issue.title}`)
        break
      case 'issue-outcome':
        console.log(
          `  结果: ${e.status}（commit ${e.commitCount}）${e.summary ? '- ' + e.summary : ''}`,
        )
        break
      case 'pull-request':
        console.log(`  ✓ PR 已创建 (#${e.prNumber}): ${e.url}`)
        break
      case 'issue-commented':
        console.log(`  留言: ${e.reason}`)
        break
      case 'no-more-tasks':
        console.log('完成：没有可处理的开放 issue。')
        break
      case 'max-iterations-reached':
        console.log(`达到迭代上限 ${e.iteration}，仍有任务未完成。`)
        break
      case 'error':
        console.error(`✗ 错误: ${e.message}${e.issue ? `（issue #${e.issue.number}）` : ''}`)
        break
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const projectDir = process.cwd()
  const argv = process.argv.slice(2)
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values.help || argv.length === 0) {
    console.log(USAGE)
    return
  }

  if (argv[0] === 'init') {
    await initCmd(projectDir)
    return
  }

  const iterations = Number(argv[0])
  if (!Number.isInteger(iterations) || iterations < 1) {
    console.error(`用法: afk <迭代次数>   （正整数，如 afk 10）`)
    console.error(`      afk init`)
    process.exitCode = 3
    return
  }

  const cfg = loadGlobalConfig()
  const projectCfg = loadProjectConfig(projectDir)
  const deepseekKey = requireDeepseekKey()

  const config = { ...cfg, label: projectCfg.label ?? cfg.label }
  appendLog(cfg.logDir, { type: 'run-start', projectDir, iterations })

  const events = await runAfkLoop({
    projectDir,
    iterations,
    config,
    deepseekKey,
  })

  printEvents(events)
  appendLog(cfg.logDir, { type: 'run-end', events: events.length })

  const errors = events.filter((e) => e.type === 'error')
  const done = events.filter((e) => e.type === 'issue-outcome' && e.status === 'done')
  const prs = events.filter((e) => e.type === 'pull-request').length

  console.log(`\n=== 摘要: ${done.length} 个 issue 完成，${prs} 个 PR，${errors.length} 个错误 ===`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
