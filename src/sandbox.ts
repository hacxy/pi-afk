import { run, pi, Output } from '@ai-hero/sandcastle'
import { docker } from '@ai-hero/sandcastle/sandboxes/docker'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { COMPLETION_SIGNAL } from './config.js'

/**
 * 结构化输出协议：
 * agent 在 <outcome> 标签中输出合法 JSON，宿主据此决定后续动作。
 * 校验失败时 sandcastle 会自动重试（resume session + 反馈错误）。
 */
export const outcomeSchema = z.object({
  status: z.enum(['done', 'blocked', 'skipped']),
  summary: z.string(),
  needsHuman: z.boolean().optional(),
})

export type Outcome = z.infer<typeof outcomeSchema>

export interface RunIssueOptions {
  /** 沙箱镜像名 */
  image: string
  /** pi 模型（provider/model 格式） */
  model: string
  /** deepseek key（注入容器 env） */
  deepseekKey: string
  /** 宿主项目目录（git 操作与 worktree 锚点） */
  projectDir: string
  /** 工作分支名，如 agent/issue-12 */
  branch: string
  /** worktree 创建基线 ref（如 origin/main）；缺省时 sandcastle 默认 HEAD */
  baseBranch?: string
  /** prompt 模板绝对路径 */
  promptFile: string
  /** 注入 prompt 的参数 */
  promptArgs: Record<string, string>
  /** 运行日志路径（全局 ~/.afk/logs/ 下） */
  logPath: string
  /** 无输出超时（秒） */
  idleTimeoutSeconds?: number
}

export interface RunIssueResult {
  outcome: Outcome
  commits: { sha: string }[]
  stdout: string
}

/**
 * 在沙箱中执行单个 issue。
 * - 每个 issue 独立分支（branch 模式，互不干扰）
 * - 沙箱零凭据（只注入 DEEPSEEK_API_KEY，保守派）
 * - agent 只提交，push/PR/关 issue 由宿主完成
 */
/** 宿主 pnpm store 根目录（去掉 /vN 版本后缀，供沙箱共享） */
function hostPnpmStoreDir(): string | undefined {
  try {
    const out = execFileSync('pnpm', ['store', 'path'], { encoding: 'utf8' }).trim()
    if (!out) return undefined
    return dirname(out)
  } catch {
    return undefined
  }
}

/**
 * 宿主 pnpm 版本（构建沙箱镜像时注入 PNPM_VERSION build-arg，
 * 保证沙箱内 pnpm 与宿主永远一致，消除宿主/沙箱漂移）。
 * 宿主未安装 pnpm 时抛错（镜像内置 pnpm 无法确定版本，宁可失败也不静默漂移）。
 */
export function hostPnpmVersion(): string {
  try {
    const out = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()
    if (!out) throw new Error('pnpm --version 输出为空')
    return out
  } catch (err) {
    throw new Error(
      `无法获取宿主 pnpm 版本（${err instanceof Error ? err.message : String(err)}）；` +
        '构建沙箱镜像需要注入 pnpm 版本，请先安装 pnpm（corepack enable 或 npm i -g pnpm）',
    )
  }
}

/**
 * docker build 命令参数（含 AGENT_UID/GID/pnpm 版本 build-arg，
 * 保证沙箱镜像 UID 与 pnpm 版本都与宿主一致）。
 */
export function dockerBuildArgs(opts: {
  image: string
  dockerfile: string
  contextDir: string
  uid: number
  gid: number
  pnpmVersion: string
}): string[] {
  const { image, dockerfile, contextDir, uid, gid, pnpmVersion } = opts
  return [
    'build',
    '-t',
    image,
    '--build-arg',
    `AGENT_UID=${uid}`,
    '--build-arg',
    `AGENT_GID=${gid}`,
    '--build-arg',
    `PNPM_VERSION=${pnpmVersion}`,
    '-f',
    dockerfile,
    contextDir,
  ]
}

/**
 * branch 策略构建（branch 模式）：新分支从 baseBranch 创建。
 * 未传 baseBranch 时省略该字段，sandcastle 回退到 HEAD 基线
 * （fetch 失败降级路径），worktree 复用路径不受影响。
 */
export function buildBranchStrategy(
  branch: string,
  baseBranch?: string,
): { type: 'branch'; branch: string; baseBranch?: string } {
  return baseBranch ? { type: 'branch', branch, baseBranch } : { type: 'branch', branch }
}

/** 按 lockfile 类型识别包管理器（决定依赖安装策略） */
function detectPackageManager(projectDir: string): 'pnpm' | 'npm' | 'yarn' | 'none' {
  if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(projectDir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(projectDir, 'package-lock.json'))) return 'npm'
  return 'none'
}

export async function runIssueInSandbox(opts: RunIssueOptions): Promise<RunIssueResult> {
  const env: Record<string, string> = { DEEPSEEK_API_KEY: opts.deepseekKey }
  const mounts: { hostPath: string; sandboxPath: string }[] = []
  const copyToWorktree: string[] = []
  let hooks: { sandbox: { onSandboxReady: { command: string }[] } } | undefined = undefined
  const pm = detectPackageManager(opts.projectDir)

  if (pm === 'pnpm') {
    // pnpm 项目：共享宿主 store（writable，pnpm 需写 sqlite 索引），
    // 不复制宿主 node_modules（macOS 平台产物是跨平台问题的根源），
    // onSandboxReady 用共享 store 秒级重建 Linux 原生 node_modules
    const storeDir = hostPnpmStoreDir()
    if (storeDir) {
      mounts.push({ hostPath: storeDir, sandboxPath: storeDir })
      env.pnpm_config_store_dir = storeDir
      env.pnpm_config_minimum_release_age = '0'
    }
    hooks = { sandbox: { onSandboxReady: [{ command: 'pnpm install' }] } }
  } else if (pm === 'npm') {
    // npm 项目：复制宿主 node_modules + 增量修复
    copyToWorktree.push('node_modules')
    hooks = { sandbox: { onSandboxReady: [{ command: 'npm install' }] } }
  } else if (pm === 'yarn') {
    copyToWorktree.push('node_modules')
    hooks = { sandbox: { onSandboxReady: [{ command: 'yarn install' }] } }
  } else {
    // 无 lockfile：复制宿主 node_modules，agent 自行处理
    copyToWorktree.push('node_modules')
  }

  // promptFile + promptArgs 才能做 {{KEY}} 占位符替换（resolvePromptFile 返回绝对路径）
  const result = await run({
    name: opts.branch,
    cwd: opts.projectDir,
    sandbox: docker({
      imageName: opts.image,
      env,
      mounts: mounts.length > 0 ? mounts : undefined,
    }),
    agent: pi(opts.model),
    branchStrategy: buildBranchStrategy(opts.branch, opts.baseBranch),
    copyToWorktree: copyToWorktree.length > 0 ? copyToWorktree : undefined,
    hooks,
    promptFile: opts.promptFile,
    promptArgs: opts.promptArgs,
    completionSignal: COMPLETION_SIGNAL,
    output: Output.object({ tag: 'outcome', schema: outcomeSchema }),
    maxIterations: 1,
    logging: { type: 'file', path: opts.logPath },
    idleTimeoutSeconds: opts.idleTimeoutSeconds ?? 600,
  })

  return {
    outcome: result.output as Outcome,
    commits: result.commits,
    stdout: result.stdout,
  }
}
