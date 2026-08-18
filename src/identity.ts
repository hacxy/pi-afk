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
 * git 提交身份解析链（配置只读 config.json；环境变量仅保留模型 API key / GH_TOKEN）：
 * ① config.json 的 gitAuthor/gitEmail（opt-in，成对提供；init 模板不含）
 * ② 宿主 `git config --global user.name/user.email`（惰性 memoize，首访 spawn 一次）
 * ③ 全部缺失 → 硬失败。
 *
 * 沙箱模式：宿主侧解析出身份后，作为 GIT_AUTHOR_* / GIT_COMMITTER_* 注入容器 env
 * （该四件套在默认沙箱白名单内），容器内 pi 的 git commit 直接使用。
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

    // ① config.json：opt-in 默认身份（成对）
    const cfgName = config.gitAuthor?.trim()
    const cfgEmail = config.gitEmail?.trim()
    if (cfgName || cfgEmail) {
      if (!cfgName || !cfgEmail) {
        throw new Error('config.json 中 gitAuthor/gitEmail 必须成对提供')
      }
      cached = { name: cfgName, email: cfgEmail }
      return cached
    }

    // ② 宿主 global gitconfig
    const globalName = globalConfig('user.name')
    const globalEmail = globalConfig('user.email')
    if (!globalName || !globalEmail) {
      throw new Error(
        '无法确定 git 提交身份：请用任一方式设置——① config.json 的 gitAuthor/gitEmail；② git config --global user.name/user.email',
      )
    }
    cached = { name: globalName, email: globalEmail }
    return cached
  }
}
