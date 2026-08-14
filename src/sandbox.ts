import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { config } from './config.js'
import { deepseekApiKey, ghToken } from './credentials.js'

export interface StageOptions {
  /** 目标项目 worktree 的宿主绝对路径 */
  worktree: string
  /** 本阶段的 prompt（注入 pi -p） */
  prompt: string
  /** 本阶段模型 */
  model: string
  /** 阶段名（planner/implementer/reviewer），决定 pi-home 目录与日志 */
  stage: string
  /** 分支名（pi-home 按分支隔离） */
  branch: string
}

export interface StageResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * 跑一个阶段：干净容器（docker run --rm）+ 容器内 pi -p。
 * - 挂 worktree → /workspace（写穿）；node_modules 匿名卷（容器内 Linux 依赖，隔离宿主）
 * - 挂 pi-home → /home/agent/.pi（session 落盘宿主，可观测性）
 * - 凭据 env 注入（GH_TOKEN / DEEPSEEK_API_KEY），不挂宿主 auth 文件
 * - 不挂宿主 pnpm store：每次容器内全量 install（稳优先，时间可接受）
 */
export function runStage(opts: StageOptions): Promise<StageResult> {
  const piHome = resolve(config.piHomeDir, opts.branch)
  mkdirSync(piHome, { recursive: true })

  const deepseekKey = deepseekApiKey()
  const args = [
    'run',
    '--rm',
    '-i',
    '-v',
    `${opts.worktree}:/workspace`,
    '-v',
    '/workspace/node_modules',
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
    config.image,
    'pi',
    '-p',
    '--model',
    opts.model,
    '--thinking',
    config.thinking,
    opts.prompt,
  ]

  return new Promise((resolvePromise) => {
    execFile('docker', args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      // error.code 为数字时是进程退出码；为字符串（如 ENOENT）是 spawn 失败，归一为 1
      const code = error ? error.code : 0
      const exitCode = typeof code === 'number' ? code : 1
      resolvePromise({ stdout, stderr, exitCode })
    })
  })
}
