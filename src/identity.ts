import { execaSync } from 'execa'

/** 读宿主 `git config --global <key>`：未配置（exit 1 / 空串）返回 undefined */
function globalConfig(key: 'user.name' | 'user.email'): string | undefined {
  const { stdout, exitCode } = execaSync('git', ['config', '--global', key], { reject: false })
  if (exitCode !== 0) return undefined
  const value = stdout.trim()
  return value.length > 0 ? value : undefined
}

/**
 * git 提交身份：解析链 = AFK_GIT_AUTHOR/AFK_GIT_EMAIL 环境变量（显式钉死，成对提供）
 * → 宿主 `git config --global user.name/user.email`（惰性 memoize，首访 spawn 一次）
 * → 都缺失则硬失败。
 *
 * docker 启动方约定：循环在容器里跑时容器内没有宿主 gitconfig，
 * 宿主侧（docker run 启动方）先解析 `git config --global user.name/email`，
 * 再以 `-e AFK_GIT_AUTHOR=... -e AFK_GIT_EMAIL=...` 传入（唯一传输通道，不挂宿主 gitconfig）。
 */

export interface GitIdentity {
  name: string
  email: string
}

/** 每次调用返回独立的 memoize 解析器实例（测试接缝：环境隔离、避免跨用例缓存串扰） */
export function createGitIdentityResolver(): () => GitIdentity {
  let cached: GitIdentity | undefined
  return () => {
    if (cached) return cached
    const name = process.env.AFK_GIT_AUTHOR?.trim()
    const email = process.env.AFK_GIT_EMAIL?.trim()
    if (name || email) {
      if (!name || !email) {
        throw new Error('AFK_GIT_AUTHOR 与 AFK_GIT_EMAIL 必须同时设置（成对提供）')
      }
      cached = { name, email }
      return cached
    }

    // env 未提供（或不全）→ 回落宿主 global gitconfig
    const globalName = globalConfig('user.name')
    const globalEmail = globalConfig('user.email')
    if (!globalName || !globalEmail) {
      throw new Error(
        '无法确定 git 提交身份：请用任一方式设置——① git config --global user.name/user.email；② 环境变量 AFK_GIT_AUTHOR/AFK_GIT_EMAIL（docker 模式由宿主侧注入）',
      )
    }
    cached = { name: globalName, email: globalEmail }
    return cached
  }
}

/** 生产单例：cli 启动校验与 executor 注入共用同一解析（每进程 memoize 一次） */
export const resolveGitIdentity = createGitIdentityResolver()
