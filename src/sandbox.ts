import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { config } from './config.js'
import { deepseekApiKey, ghToken } from './credentials.js'
import {
  normalizeExitCode,
  runJsonlStage,
  type ExecutorHooks,
  type SpawnFn,
  type StageContext,
  type StageResult,
} from './executor.js'
import { log, logError } from './log.js'

export interface SandboxOptions {
  /** 工作容器镜像 */
  image: string
  /** 目标项目 worktree 宿主绝对路径（挂载 /workspace，写穿） */
  worktree: string
  /** 目标仓库根（宿主 cwd）：.git 同路径挂载基准（A' 接缝，#37） */
  repoRoot: string
  /** 分支名（决定容器名 + pi-home 目录） */
  branch: string
  /** 可选：覆盖 lockfile 检测的依赖安装命令（AFK_INSTALL_CMD） */
  installCmd?: string
  /** pi-home 宿主目录（默认 config.piHomeDir），按分支隔离 */
  piHomeDir?: string
  /** 会话 JSONL 落盘目录（默认 config.sessionsDir） */
  sessionDir?: string
  idleMs?: number
  completionMs?: number
  /** spawn 工厂：默认 docker CLI spawn，测试注入假进程 */
  spawnFn?: SpawnFn
}

/**
 * 常驻容器沙箱（A7，issue #39）：每个 issue 一个 `docker run -d` 容器，
 * planner → implementer → reviewer 三阶段 `docker exec` 复用，依赖只装一次；
 * 成功/失败都由编排层 try/finally 调 destroy() 销毁，无孤儿容器。
 */
export interface Sandbox {
  /** 容器名（docker exec / rm 用） */
  readonly name: string
  /** onSandboxReady hook：依赖安装（编排层在容器就绪时调一次，agent 不自装） */
  installDeps(): Promise<void>
  /** 跑一个阶段：docker exec pi -p --mode json（共享事件流层） */
  runStage(ctx: StageContext, hooks?: ExecutorHooks): Promise<StageResult>
  /** 销毁容器：幂等、绝不抛错（finally 安全，不掩盖原始错误） */
  destroy(): Promise<void>
}

/** docker 容器名：只允许 [a-zA-Z0-9_.-] 且不能以数字/符号开头 */
export function containerName(branch: string): string {
  let safe = branch
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!safe) safe = 'issue'
  if (!/^[a-z]/.test(safe)) safe = `issue-${safe}`
  return safe
}

/**
 * 依赖安装命令（D2）：按 lockfile 检测。
 * 无 lockfile 抛错——编排层无法确定安装方式时宁可失败，也不让 agent 自己装。
 */
export function installCommand(worktree: string): string {
  if (existsSync(join(worktree, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile'
  if (existsSync(join(worktree, 'package-lock.json'))) return 'npm ci'
  if (existsSync(join(worktree, 'yarn.lock'))) return 'yarn install --immutable'
  if (existsSync(join(worktree, 'bun.lockb'))) return 'bun install --frozen-lockfile'
  throw new Error(
    '未找到 lockfile（pnpm-lock.yaml / package-lock.json / yarn.lock / bun.lockb），无法确定依赖安装命令',
  )
}

/** 跑一条「非事件流」docker 命令并收集输出（容器生命周期操作用） */
export function collectOutput(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise) => {
    const child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (err) => {
      // spawn 失败（如 docker 不存在）→ 归一退出码 1
      resolvePromise({ stdout, stderr: stderr || String(err), exitCode: 1 })
    })
    child.on('exit', (code, signal) => {
      resolvePromise({ stdout, stderr, exitCode: normalizeExitCode(code, signal) })
    })
  })
}

/**
 * 创建常驻容器（A7）：`docker run -d --name <name> <image>`。
 * 挂载（A' 接缝 + A13）：
 * - worktree → /workspace（写穿）；node_modules 匿名卷（容器内 Linux 依赖）
 * - 宿主 .git 同路径可写 + hooks/config 子挂载只读（容器内 git commit 可行，#37）
 * - pi-home → /home/agent/.pi（按分支隔离）
 * 凭据 env 注入（GH_TOKEN / DEEPSEEK_API_KEY），不挂宿主 auth 文件。
 */
export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const spawnFn = opts.spawnFn ?? spawn
  const name = containerName(opts.branch)
  const piHome = resolve(opts.piHomeDir ?? config.piHomeDir, opts.branch)
  mkdirSync(piHome, { recursive: true })

  // 孤儿容器兜底：同名残留先强制销毁（否则 docker run --name 会冲突失败）
  await collectOutput(spawnFn, 'docker', ['rm', '-f', name])

  const deepseekKey = deepseekApiKey()
  const args = [
    'run',
    '-d',
    '--name',
    name,
    '-v',
    `${opts.worktree}:/workspace`,
    '-v',
    '/workspace/node_modules',
    // A' 接缝（#37）：宿主 .git 同路径可写 + hooks/config 子挂载只读，容器内 commit 可行
    '-v',
    `${opts.repoRoot}/.git:${opts.repoRoot}/.git`,
    '-v',
    `${opts.repoRoot}/.git/hooks:${opts.repoRoot}/.git/hooks:ro`,
    '-v',
    `${opts.repoRoot}/.git/config:${opts.repoRoot}/.git/config:ro`,
    '-v',
    `${piHome}:/home/agent/.pi`,
    '-e',
    `GH_TOKEN=${ghToken()}`,
    ...(deepseekKey ? ['-e', `DEEPSEEK_API_KEY=${deepseekKey}`] : []),
    '-e',
    `GIT_AUTHOR_NAME=${config.gitAuthor}`,
    '-e',
    `GIT_AUTHOR_EMAIL=${config.gitEmail}`,
    '-e',
    `GIT_COMMITTER_NAME=${config.gitAuthor}`,
    '-e',
    `GIT_COMMITTER_EMAIL=${config.gitEmail}`,
    opts.image,
  ]
  const { stdout, stderr, exitCode } = await collectOutput(spawnFn, 'docker', args)
  if (exitCode !== 0) {
    throw new Error(`docker run 失败（${exitCode}）: ${stderr.slice(-2000)}`)
  }
  const id = stdout.trim()
  log(`容器 ${name} 就绪（${id}）`)
  return new ContainerSandbox(opts, name)
}

/** 容器后端：绑定一个常驻容器的 Executor 适配（A3/A6）。 */
export class ContainerSandbox implements Sandbox {
  constructor(
    private readonly opts: SandboxOptions,
    readonly name: string,
  ) {}

  async installDeps(): Promise<void> {
    const cmd = this.opts.installCmd ?? installCommand(this.opts.worktree)
    const spawnFn = this.opts.spawnFn ?? spawn
    const { stderr, exitCode } = await collectOutput(spawnFn, 'docker', [
      'exec',
      '-i',
      this.name,
      'sh',
      '-lc',
      `cd /workspace && ${cmd}`,
    ])
    if (exitCode !== 0) {
      throw new Error(`依赖安装失败（${exitCode}）: ${stderr.slice(-2000)}`)
    }
  }

  runStage(ctx: StageContext, hooks?: ExecutorHooks): Promise<StageResult> {
    // 同一容器内 docker exec pi：事件流走共享层（分帧/解析/双超时/落盘/退出码归一）
    return runJsonlStage(ctx, hooks, {
      command: 'docker',
      args: [
        'exec',
        '-i',
        this.name,
        'pi',
        '-p',
        '--mode',
        'json',
        '--model',
        ctx.model,
        '--thinking',
        config.thinking,
        ctx.prompt,
      ],
      spawnFn: this.opts.spawnFn ?? spawn,
      idleMs: this.opts.idleMs ?? config.idleTimeoutSec * 1000,
      completionMs: this.opts.completionMs ?? config.completionTimeoutSec * 1000,
      sessionDir: this.opts.sessionDir ?? config.sessionsDir,
    })
  }

  async destroy(): Promise<void> {
    try {
      await collectOutput(this.opts.spawnFn ?? spawn, 'docker', ['rm', '-f', this.name])
    } catch (error) {
      // 销毁失败不致命，但可观测（无孤儿容器是验收项）
      logError(`容器销毁失败（${this.name}）：${error instanceof Error ? error.message : error}`)
    }
  }
}
