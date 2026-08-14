import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { config } from './config.js'
import { normalizeExitCode } from './executor.js'
import { log } from './log.js'

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

/**
 * 宿主侧依赖安装（编排层负责，agent 不自装）：
 * worktree 建好后、implementer 前，在 worktree 里跑一次 install。
 * CI=true 保证无 TTY 下 pnpm 等不会交互性 abort。
 */
export function installDeps(worktree: string): Promise<void> {
  const cmd = config.installCmd ?? installCommand(worktree)
  log(`依赖安装：${cmd}（worktree）`)
  const parts = cmd.trim().split(/\s+/)
  const bin = parts[0]
  if (!bin) throw new Error('依赖安装命令为空（AFK_INSTALL_CMD 未配置或为空）')
  const args = parts.slice(1)
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(bin, args, {
      cwd: worktree,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (err) => {
      reject(new Error(`依赖安装启动失败：${err.message}\n${(stderr || stdout).slice(-2000)}`))
    })
    child.on('exit', (code, signal) => {
      const exitCode = normalizeExitCode(code, signal)
      if (exitCode !== 0) {
        reject(new Error(`依赖安装失败（${exitCode}）: ${(stderr || stdout).slice(-2000)}`))
      } else {
        resolvePromise()
      }
    })
  })
}
