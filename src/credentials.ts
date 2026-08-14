import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** GH_TOKEN：从宿主 gh 认证获取（容器内 gh/planner 拉 issue 需要） */
export function ghToken(): string {
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!token) throw new Error('empty')
    return token
  } catch {
    throw new Error('gh 未认证：请先运行 `gh auth login`')
  }
}

/**
 * DeepSeek API Key：从宿主 pi 的 auth.json 读取（结构 { deepseek: { type, key } }）。
 * 通过 env 注入容器，不挂载 auth 文件本身。
 */
export function deepseekApiKey(): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), '.pi/agent/auth.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const key = (auth.deepseek as { key?: unknown } | undefined)?.key
    return typeof key === 'string' ? key : undefined
  } catch {
    return undefined
  }
}
