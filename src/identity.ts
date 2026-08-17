import type { Config } from './config.js'

import { execaSync } from 'execa'

/** 读宿主 `git config --global <key>`：未配置（exit 1 / 空串）返回 undefined */
function globalConfig(key: 'user.name' | 'user.email'): string | undefined {
  const { stdout, exitCode } = execaSync('git', ['config', '--global', key], { reject: false })
  if (exitCode !== 0) return undefined
  const value = stdout.trim()
  return value.length > 0 ? value : undefined
}

/**
 * git 提交身份解析链（env 最高优先级，docker/CI 注入通道永不失效）：
 * ① 环境变量 AFK_GIT_AUTHOR/AFK_GIT_EMAIL（成对提供）
 * ② config.json 的 gitAuthor/gitEmail（opt-in，成对提供；init 模板不含）
 * ③ 宿主 `git config --global user.name/user.email`（惰性 memoize，首访 spawn 一次）
 * ④ 全部缺失 → 硬失败。
 *
 * docker 启动方约定：循环在容器里跑时容器内没有宿主 gitconfig，
 * 宿主侧（docker run 启动方）先解析 `git config --global user.name/email`，
 * 再以 `-e AFK_GIT_AUTHOR=... -e AFK_GIT_EMAIL=...` 传入（唯一最高优先级通道）。
 */
export interface GitIdentity {
  name: string
  email: string
}

/** 每次调用返回独立的 memoize 解析器实例（测试接缝：环境隔离、避免跨用例缓存串扰） */
export function createGitIdentityResolver(
  config: Pick<Config, 'gitAuthor' | 'gitEmail'>,
): () => GitIdentity {
  let cached: GitIdentity | undefined
  return () => {
    if (cached) return cached

    // ① env：docker/CI 注入通道，永远可覆盖下方所有来源
    const envName = process.env.AFK_GIT_AUTHOR?.trim()
    const envEmail = process.env.AFK_GIT_EMAIL?.trim()
    if (envName || envEmail) {
      if (!envName || !envEmail) {
        throw new Error('AFK_GIT_AUTHOR 与 AFK_GIT_EMAIL 必须同时设置（成对提供）')
      }
      cached = { name: envName, email: envEmail }
      return cached
    }

    // ② config.json：opt-in 默认身份（成对）
    const cfgName = config.gitAuthor?.trim()
    const cfgEmail = config.gitEmail?.trim()
    if (cfgName || cfgEmail) {
      if (!cfgName || !cfgEmail) {
        throw new Error(
          'config.json 中 gitAuthor/gitEmail 必须成对提供（或改用环境变量 AFK_GIT_AUTHOR/AFK_GIT_EMAIL）',
        )
      }
      cached = { name: cfgName, email: cfgEmail }
      return cached
    }

    // ③ 宿主 global gitconfig
    const globalName = globalConfig('user.name')
    const globalEmail = globalConfig('user.email')
    if (!globalName || !globalEmail) {
      throw new Error(
        '无法确定 git 提交身份：请用任一方式设置——① git config --global user.name/user.email；② 环境变量 AFK_GIT_AUTHOR/AFK_GIT_EMAIL（docker 模式由宿主侧注入）；③ config.json 的 gitAuthor/gitEmail',
      )
    }
    cached = { name: globalName, email: globalEmail }
    return cached
  }
}
