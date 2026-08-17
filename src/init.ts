import { execaSync } from 'execa'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_FILE, DEFAULT_CONFIG } from './config.js'

export interface InitResult {
  /** 生成的 config.json 绝对路径 */
  configPath: string
  /** 探测到的 baseBranch（无 origin/HEAD 回落 main） */
  baseBranch: string
  /** gitignore 维护动作：created / appended / replaced / unchanged */
  gitignore: 'created' | 'appended' | 'replaced' | 'unchanged'
}

/** gitignore 自动维护块：运行时产物忽略 + config.json 例外（可入库） */
const GITIGNORE_BLOCK = [
  '# >>> afk init 自动维护：afk 运行时产物忽略 + config.json 入库 <<<',
  '.pi/afk/*',
  '!.pi/afk/config.json',
  '# <<< afk end >>>',
].join('\n')

const BLOCK_START = GITIGNORE_BLOCK.split('\n')[0] ?? GITIGNORE_BLOCK
const BLOCK_END = '# <<< afk end >>>'

/**
 * 确保 .gitignore 白名单规则（幂等）：
 * - 已有整体忽略裸行 `.pi/afk/`（git 不允许重新包含已忽略目录的子文件）→ 改写为白名单块
 * - 已有标记块 → 内容不一致才重写，否则不动
 * - 无规则 → 追加（文件不存在则创建）
 * 返回实际动作，供 init 输出提示。
 */
export function ensureGitignore(cwd: string): InitResult['gitignore'] {
  const file = join(cwd, '.gitignore')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = existing.split('\n')
  const bareIdx = lines.findIndex((l) => l.trim() === '.pi/afk/')
  const startIdx = lines.findIndex((l) => l.trim() === BLOCK_START)
  const endIdx = lines.findIndex((l) => l.trim() === BLOCK_END)
  const blockLines = GITIGNORE_BLOCK.split('\n')

  if (bareIdx !== -1 && startIdx === -1) {
    // 老规则：裸行 `.pi/afk/` → 原位替换为白名单块（只动精确匹配行）
    lines.splice(bareIdx, 1, ...blockLines)
    writeFileSync(file, `${lines.join('\n')}\n`)
    return 'replaced'
  }
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // 已有块：内容一致 → 不动；不一致 → 重写块内容
    const current = lines.slice(startIdx, endIdx + 1).join('\n')
    if (current === GITIGNORE_BLOCK) return 'unchanged'
    lines.splice(startIdx, endIdx - startIdx + 1, ...blockLines)
    writeFileSync(file, `${lines.join('\n')}\n`)
    return 'replaced'
  }

  // 无规则：追加（保持现有内容与块之间有换行分隔）
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  writeFileSync(file, `${existing}${separator}${GITIGNORE_BLOCK}\n`)
  return existing.length > 0 ? 'appended' : 'created'
}

/**
 * `afk init`：初始化项目 afk 配置。
 * - 必须位于 git 仓库内（afk 全家桶依赖 git/gh）
 * - baseBranch 探测 origin/HEAD，失败回落 main
 * - 写 <cwd>/.pi/afk/config.json（全量默认值模板，含探测的 baseBranch）
 * - 已存在且无 --force → 报错
 */
export function runInit(cwd: string = process.cwd(), opts: { force?: boolean } = {}): InitResult {
  const inRepo = execaSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    reject: false,
  })
  if (inRepo.exitCode !== 0) {
    throw new Error(
      'afk init 需要在 git 仓库内执行（当前目录不是 git 仓库）\n请先执行 git init，或在项目根目录运行 afk init',
    )
  }

  const baseBranch = detectBaseBranch(cwd)

  // gitignore 与 config.json 创建解耦：无论后者状态如何，先幂等确保规则（可修老项目）
  const gitignore = ensureGitignore(cwd)

  const configPath = join(cwd, CONFIG_FILE)
  if (existsSync(configPath) && !opts.force) {
    throw new Error(`配置已存在 ${configPath}\n如需覆盖为默认值：afk init --force`)
  }
  const template = { ...DEFAULT_CONFIG, baseBranch }
  mkdirSync(join(cwd, '.pi', 'afk'), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`)

  return { configPath, baseBranch, gitignore }
}

/** 探测 origin/HEAD 的默认分支名（refs/heads/<name>），无则回落内置 main */
function detectBaseBranch(cwd: string): string {
  const out = execaSync('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    cwd,
    reject: false,
  })
  if (out.exitCode !== 0) return DEFAULT_CONFIG.baseBranch
  const ref = out.stdout.trim()
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : DEFAULT_CONFIG.baseBranch
}
