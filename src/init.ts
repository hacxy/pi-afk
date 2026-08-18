import { execa, execaSync } from 'execa'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CONFIG_FILE, DEFAULT_CONFIG, type Config } from './config.js'
import { ensureLabels } from './issues.js'
import { DOCKERFILE_REL, defaultDockerfile, detectNodeVersion, sandboxImageTag } from './sandbox.js'

export interface InitResult {
  /** 生成的 config.json 绝对路径 */
  configPath: string
  /** 探测到的 baseBranch（无 origin/HEAD 回落 main） */
  baseBranch: string
  /** gitignore 维护动作：created / appended / replaced / unchanged */
  gitignore: 'created' | 'appended' | 'replaced' | 'unchanged'
  /** Dockerfile 维护动作：created / replaced / unchanged（内容寻址，变了重跑 init 即重建） */
  dockerfile: 'created' | 'replaced' | 'unchanged'
  /** 构建出的沙箱镜像 tag（内容寻址） */
  imageTag: string
  /** 本次补建的状态机 label（已存在的未计入） */
  labelsCreated: string[]
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
 * 生成/幂等维护沙箱 Dockerfile（<cwd>/.pi/afk/Dockerfile）：
 * - 宿主 pi 版本写死（`pi --version` 探测；失败 → 硬失败，镜像必须版本确定防漂移）
 * - node 基底按项目 engines.node 探测（回落 node:24）
 * - 内容一致 → unchanged，已存在被改 → replaced 重写
 */
async function ensureDockerfile(cwd: string): Promise<InitResult['dockerfile']> {
  const file = join(cwd, DOCKERFILE_REL)
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : undefined

  const { stdout, exitCode } = await execa('pi', ['--version'], { reject: false })
  const piVersion = exitCode === 0 ? stdout.trim() : ''
  if (!piVersion) {
    throw new Error(
      '未检测到宿主 pi（pi --version 失败）：沙箱镜像需要固定宿主 pi 版本（防漂移）\n' +
        '请确认已安装 pi（npm i -g @earendil-works/pi-coding-agent）后重跑 afk init',
    )
  }

  const nodeMajor = detectNodeVersion(cwd)
  const dockerfile = defaultDockerfile(piVersion, nodeMajor)
  if (existing === dockerfile) return 'unchanged'

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, dockerfile)
  return existing === undefined ? 'created' : 'replaced'
}

/**
 * 构建沙箱镜像（内容寻址 tag）：docker build -t <tag> -f Dockerfile <Dockerfile 目录>。
 * context 用 Dockerfile 所在目录（模板不 COPY 项目内容，避免上传整个仓库）。
 * 失败 → 抛错（Dockerfile 已落盘，修复后重跑 init 幂等续建；tag 未变缓存秒过）。
 */
async function buildSandboxImage(cwd: string, imageTag: string): Promise<void> {
  try {
    const { exitCode, stderr } = await execa(
      'docker',
      [
        'build',
        '-t',
        imageTag,
        '-f',
        join(cwd, DOCKERFILE_REL),
        dirname(join(cwd, DOCKERFILE_REL)),
      ],
      { reject: false },
    )
    if (exitCode !== 0) {
      throw new Error(`镜像构建失败（${exitCode}）: ${(stderr ?? '').slice(-2000)}`)
    }
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      throw new Error('docker 不可用：沙箱模式需要 docker（或显式 --local 在本地运行）')
    }
    throw error
  }
}

/**
 * `afk init`：初始化项目 afk 配置。
 * - 必须位于 git 仓库内（afk 全家桶依赖 git/gh）
 * - baseBranch 探测 origin/HEAD，失败回落 main
 * - 生成并构建沙箱镜像（Dockerfile + docker build；构建失败 → 中止，重跑 init 幂等续建）
 * - 写 <cwd>/.pi/afk/config.json（全量默认值模板，含探测的 baseBranch）
 * - 幂等补建状态机 label（gh label list → 只建缺失）；任何失败 → 抛错（开箱即用目标）
 * - 已存在且无 --force → 报错
 */
export async function runInit(
  cwd: string = process.cwd(),
  opts: { force?: boolean } = {},
): Promise<InitResult> {
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

  // 沙箱镜像：Dockerfile 生成必须先于 config 写入（构建失败时重跑 init 无 --force 冲突）
  const dockerfile = await ensureDockerfile(cwd)
  const imageTag = sandboxImageTag(cwd)
  await buildSandboxImage(cwd, imageTag)

  const configPath = join(cwd, CONFIG_FILE)
  if (existsSync(configPath) && !opts.force) {
    // 镜像已构建，只有 config 挡着：错误信息给清晰路径
    throw new Error(`配置已存在 ${configPath}\n如需覆盖为默认值：afk init --force`)
  }
  const template: Config = { ...DEFAULT_CONFIG, baseBranch }
  mkdirSync(join(cwd, '.pi', 'afk'), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`)

  // 幂等补建状态机 label：任何失败都算初始化不完整（开箱即用目标）
  const { created, failed } = await ensureLabels(template)
  if (failed.length > 0) {
    throw new Error(
      `label 创建失败：\n${failed.map((f) => `- ${f.name}: ${f.error}`).join('\n')}\n` +
        '请确认 gh 已登录且对该仓库有写权限（或手动 gh label create 后重跑 afk init）',
    )
  }

  return { configPath, baseBranch, gitignore, dockerfile, imageTag, labelsCreated: created }
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
