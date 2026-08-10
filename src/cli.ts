/* eslint-disable no-console */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import {
  loadGlobalConfig,
  globalConfigPath,
  DEFAULT_GLOBAL_CONFIG,
  ensureGlobalDirs,
  LOG_DIR,
  type GlobalConfig,
} from './config.js'
import { requireDeepseekKey } from './credentials.js'
import { collectDoctorFacts, doctorReport, startupTemplateLine } from './doctor.js'
import { appendLog } from './log.js'
import { runAfkLoop, type LoopEvent } from './loop.js'
import {
  ensureProjectPrompt,
  ensureSandcastleGitignore,
  ensureProjectResolvePrompt,
} from './prompts.js'
import { dockerBuildArgs, hostPnpmVersion } from './sandbox.js'

const USAGE = `pi-afk —— 基于 sandcastle 的 AFK 循环编排器

用法:
  afk <迭代次数>        在当前项目目录运行 AFK 循环（处理开放 issue；配置了 labels 则按标签过滤，默认不过滤）
  afk init              初始化：构建沙箱镜像、生成全局配置、复制项目模板、检查凭据
  afk doctor            诊断：生效配置 / 模板路径 / 镜像与 gh 状态（纯只读，无副作用）
  afk --help            显示帮助

环境变量:
  DEEPSEEK_API_KEY      deepseek API key（必填）

配置:
  全局: ~/.afk/config.json（image / model / labels / autoMerge / verifyCommand）

模板:
  项目 .sandcastle/prompt.md（自定义，可提交 git）> 包内默认 prompts/prompt.md
  项目 .sandcastle/resolve.md（冲突自动化解，可提交 git）> 包内默认 prompts/resolve.md
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

/** 检查沙箱镜像，不存在则构建（全局一次，所有项目复用） */
function ensureImage(cfg: GlobalConfig): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', cfg.image], { stdio: 'ignore' })
    return true
  } catch {
    // 不存在，构建
  }
  console.log(`→ 构建沙箱镜像 ${cfg.image}（首次约 1-2 分钟）...`)
  const dockerfile = dockerfilePath()
  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000
  // pnpm 版本注入：构建产物永远与宿主一致（不硬编码）
  let pnpmVersion: string
  try {
    pnpmVersion = hostPnpmVersion()
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  try {
    execFileSync(
      'docker',
      dockerBuildArgs({
        image: cfg.image,
        dockerfile,
        contextDir: dirname(dockerfile),
        uid,
        gid,
        pnpmVersion,
      }),
      { stdio: 'inherit' },
    )
    console.log(`✓ 镜像构建完成: ${cfg.image}`)
    return true
  } catch {
    console.error('✗ 镜像构建失败，请检查 docker 是否在运行（OrbStack）')
    return false
  }
}

/** 项目模板：幂等复制默认模板到 .sandcastle/prompt.md 与 .sandcastle/resolve.md（已存在则跳过） */
function ensureProjectTemplate(projectDir: string): void {
  const path = ensureProjectPrompt(projectDir)
  console.log(`✓ 项目模板就绪: ${path}（可编辑后提交 git，团队共享）`)
  const resolvePath = ensureProjectResolvePrompt(projectDir)
  console.log(`✓ resolve 模板就绪: ${resolvePath}（预同步冲突自动化解）`)
}

/** 全局环境就绪（幂等）：生成全局配置 + 确保日志目录；init 与运行时自动初始化共用的唯一入口 */
function ensureGlobalEnv(): void {
  ensureGlobalConfig()
  ensureGlobalDirs()
}

/** 运行时前置检查（afk <N> 每次自动执行，无需手动 init） */
function ensureRuntime(cfg: GlobalConfig, projectDir: string): boolean {
  ensureGlobalEnv()
  ensureSandcastleGitignore(projectDir)
  ensureProjectTemplate(projectDir)
  if (!requireDeepseekKey()) {
    return false
  }
  return ensureImage(cfg)
}

async function initCmd(projectDir: string): Promise<void> {
  const cfg = loadGlobalConfig()

  // 1. 全局环境（配置 + 日志目录）
  ensureGlobalEnv()

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
  if (ensureImage(cfg)) {
    console.log(`✓ 沙箱镜像: ${cfg.image}`)
  } else {
    return
  }

  // 5. 项目 .gitignore 忽略运行时产物（prompt.md 可提交）
  ensureSandcastleGitignore(projectDir)
  console.log('✓ .gitignore 已配置（.sandcastle 运行时产物忽略，prompt.md 可提交）')

  // 6. 项目模板：幂等复制默认模板到 .sandcastle/prompt.md
  ensureProjectTemplate(projectDir)

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
      case 'issue-merged':
        console.log(`  ✓ PR #${e.prNumber} 已合并，issue #${e.issue.number} 随之关闭`)
        break
      case 'pr-exists-merged':
        console.log(`  ⏭ 已有已合并 PR #${e.prNumber}（issue #${e.issue.number}），本轮跳过`)
        break
      case 'pr-pending-manual-merge':
        console.log(
          `  ⏭ 已有 PR #${e.prNumber} 待人工合并（issue #${e.issue.number}），本轮跳过，不自动合并`,
        )
        break
      case 'pr-conflict-skip':
        console.warn(
          `  ⏭ 已有 PR #${e.prNumber} 存在冲突（issue #${e.issue.number}），已留言，待人工解决`,
        )
        break
      case 'presync-conflict':
        console.warn(
          `  ⚠ 预同步冲突（issue #${e.issue.number}）: ${e.files.length} 个冲突文件，派发 resolve run 自动解冲突`,
        )
        break
      case 'resolve-failed':
        console.warn(
          `  ✗ 自动解冲突失败（issue #${e.issue.number}）: ${e.reason}——已回退兜底（push + PR + 冲突留言）`,
        )
        break
      case 'verify-failed':
        console.error(`  ✗ 验证未通过，未发布（issue #${e.issue.number}）: ${e.reason}`)
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

  if (argv[0] === 'doctor') {
    // 纯诊断：只读配置/模板/镜像/gh，不做任何写操作（不生成配置、不建镜像、不复制模板）
    console.log(doctorReport(collectDoctorFacts(projectDir)))
    return
  }

  const iterations = Number(argv[0])
  if (!Number.isInteger(iterations) || iterations < 1) {
    console.error(`用法: afk <迭代次数>   （正整数，如 afk 10）`)
    console.error(`      afk init`)
    console.error(`      afk doctor`)
    process.exitCode = 3
    return
  }

  const cfg = loadGlobalConfig()

  // 启动打印：当前生效的模板路径（项目 .sandcastle/prompt.md 或包内默认）
  console.log(startupTemplateLine(projectDir))

  // 运行时前置检查（自动初始化：配置/镜像/gitignore，无需手动 afk init）
  if (!ensureRuntime(cfg, projectDir)) {
    process.exitCode = 1
    return
  }

  const deepseekKey = requireDeepseekKey()

  appendLog(LOG_DIR, { type: 'run-start', projectDir, iterations })

  const events = await runAfkLoop({
    projectDir,
    iterations,
    config: cfg,
    deepseekKey,
  })

  printEvents(events)
  appendLog(LOG_DIR, { type: 'run-end', events: events.length })

  const errors = events.filter((e) => e.type === 'error')
  const done = events.filter((e) => e.type === 'issue-outcome' && e.status === 'done')
  const prs = events.filter((e) => e.type === 'pull-request').length

  console.log(`\n=== 摘要: ${done.length} 个 issue 完成，${prs} 个 PR，${errors.length} 个错误 ===`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
