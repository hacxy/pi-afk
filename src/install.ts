import type { Config } from './config.js'

import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { log } from './log.js'
import { containerBaseArgs, filterSandboxEnv, sandboxHomeDir } from './sandbox.js'

/** 依赖安装命令（按 lockfile 检测）。无 lockfile 抛错——无法确定安装方式时宁可失败，也不让 agent 自己装。 */
export function installCommand(worktree: string): string {
  if (existsSync(join(worktree, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile'
  if (existsSync(join(worktree, 'package-lock.json'))) return 'npm ci'
  if (existsSync(join(worktree, 'yarn.lock'))) return 'yarn install --immutable'
  if (existsSync(join(worktree, 'bun.lockb'))) return 'bun install --frozen-lockfile'
  throw new Error(
    '未找到 lockfile（pnpm-lock.yaml / package-lock.json / yarn.lock / bun.lockb），无法确定依赖安装命令',
  )
}

interface ExecaError {
  exitCode?: number
  stdout?: string
  stderr?: string
  message: string
}

/**
 * 依赖安装（编排层负责，agent 不自装）：worktree 建好后、implementer 前跑一次 install。
 * 沙箱模式（config.sandbox=true，默认）→ 容器内执行（镜像需已由 afk init 构建，
 * imageTag 由调用方经 requireSandboxImage 校验后传入）；--local → 宿主执行。
 * CI=true 保证无 TTY 下 pnpm 等不会交互性 abort。logFn 由调用方注入（issue 级日志器）。
 */
export async function installDeps(
  worktree: string,
  config: Config,
  logFn: (msg: string) => void = log,
  opts: { imageTag?: string } = {},
): Promise<void> {
  const cmd = config.installCmd ?? installCommand(worktree)
  logFn(`依赖安装：${cmd}`)
  const parts = cmd.trim().split(/\s+/)
  const bin = parts[0]
  if (!bin) throw new Error('依赖安装命令为空（installCmd 未配置且无 lockfile）')
  if (config.sandbox) {
    if (!opts.imageTag) {
      throw new Error('沙箱模式下依赖安装需要已构建镜像（imageTag）：请先执行 afk init')
    }
    // 容器内安装：与 agent 容器同挂载/同 user/同白名单 env，覆盖 ENTRYPOINT 直跑 install
    const base = containerBaseArgs({
      worktree,
      homeDir: sandboxHomeDir(),
      memory: config.sandboxMemory,
      cpus: config.sandboxCpus,
    })
    const args = [...base, '-w', '/workspace', '--entrypoint', 'sh', opts.imageTag, '-c', cmd]
    try {
      await execa('docker', args, {
        cwd: worktree,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...filterSandboxEnv(process.env, config.sandboxEnv), CI: 'true' },
      })
      return
    } catch (error) {
      const e = error as ExecaError
      const exitCode = e.exitCode ?? 1
      const detail = (e.stderr || e.stdout || e.message).slice(-2000)
      throw new Error(`依赖安装失败（${exitCode}）: ${detail}`)
    }
  }
  const args = parts.slice(1)
  try {
    await execa(bin, args, {
      cwd: worktree,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' },
    })
  } catch (error) {
    const e = error as ExecaError
    const exitCode = e.exitCode ?? 1
    const detail = (e.stderr || e.stdout || e.message).slice(-2000)
    throw new Error(`依赖安装失败（${exitCode}）: ${detail}`)
  }
}
