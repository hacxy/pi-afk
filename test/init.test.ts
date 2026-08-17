import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'
import { runInit } from '../src/init.js'

/** git 命令环境：隔离宿主 gitconfig，避免测试被宿主 user.name 等干扰 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

let dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'afk-init-'))
  dirs.push(dir)
  return dir
}

function tempGitRepo(): string {
  const dir = tempDir()
  execSync('git init -q', { cwd: dir, env: GIT_ENV })
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('runInit 初始化', () => {
  it('非 git 仓库 → 报错并提示先 git init', () => {
    const cwd = tempDir()
    expect(() => runInit(cwd)).toThrow(/git init/)
  })

  it('创建 config.json：全量默认值 + baseBranch 探测 origin/HEAD', () => {
    const cwd = tempGitRepo()
    execSync('git symbolic-ref refs/remotes/origin/HEAD refs/heads/develop', { cwd, env: GIT_ENV })

    const result = runInit(cwd)

    expect(result.baseBranch).toBe('develop')
    expect(result.configPath).toBe(join(cwd, '.pi', 'afk', 'config.json'))
    const cfg = loadConfig(cwd)
    expect(cfg.baseBranch).toBe('develop')
    expect(cfg.model).toBe('deepseek/deepseek-v4-flash')
    expect(cfg.thinking).toBe('medium')
    expect(cfg.maxParallel).toBe(2)
  })

  it('无 origin/HEAD → baseBranch 回落 main', () => {
    const cwd = tempGitRepo()

    const result = runInit(cwd)

    expect(result.baseBranch).toBe('main')
    expect(loadConfig(cwd).baseBranch).toBe('main')
  })

  it('config.json 已存在 → 报错并提示 --force', () => {
    const cwd = tempGitRepo()
    runInit(cwd)

    expect(() => runInit(cwd)).toThrow(/已存在/)
    expect(() => runInit(cwd)).toThrow(/--force/)
  })

  it('--force → 覆盖写为默认模板（探测的 baseBranch 生效）', () => {
    const cwd = tempGitRepo()
    mkdirSync(join(cwd, '.pi', 'afk'), { recursive: true })
    writeFileSync(join(cwd, '.pi', 'afk', 'config.json'), JSON.stringify({ baseBranch: 'develop' }))

    runInit(cwd, { force: true })

    const cfg = loadConfig(cwd)
    expect(cfg.baseBranch).toBe('main') // 探测无 origin/HEAD → main，覆盖旧的 develop
    expect(cfg.model).toBe('deepseek/deepseek-v4-flash')
  })

  it('模板不含身份键与 installCmd（身份走机器本地 env/global）', () => {
    const cwd = tempGitRepo()
    runInit(cwd)

    const raw = readFileSync(join(cwd, '.pi', 'afk', 'config.json'), 'utf8')
    expect(raw).not.toContain('gitAuthor')
    expect(raw).not.toContain('gitEmail')
    expect(raw).not.toContain('installCmd')
  })

  it('无 .gitignore → 创建并写入白名单块（config.json 可入库）', () => {
    const cwd = tempGitRepo()

    const result = runInit(cwd)

    expect(result.gitignore).toBe('created')
    const raw = readFileSync(join(cwd, '.gitignore'), 'utf8')
    expect(raw).toContain('.pi/afk/*')
    expect(raw).toContain('!.pi/afk/config.json')
  })

  it('已有整体忽略裸行 .pi/afk/ → 改写为白名单块，其余内容保留', () => {
    const cwd = tempGitRepo()
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n# afk 运行时产物\n.pi/afk/\ndist/\n')

    const result = runInit(cwd)

    expect(result.gitignore).toBe('replaced')
    const raw = readFileSync(join(cwd, '.gitignore'), 'utf8')
    // 老规则被移除，白名单生效
    expect(raw.split('\n').map((l) => l.trim())).not.toContain('.pi/afk/')
    expect(raw).toContain('.pi/afk/*')
    expect(raw).toContain('!.pi/afk/config.json')
    // 无关行保留
    expect(raw).toContain('node_modules/')
    expect(raw).toContain('dist/')
  })

  it('已有标记块 → 幂等：不重复追加', () => {
    const cwd = tempGitRepo()
    runInit(cwd)

    const result = runInit(cwd, { force: true }) // 二次运行（--force 跳过已存在报错）

    expect(result.gitignore).toBe('unchanged')
    const raw = readFileSync(join(cwd, '.gitignore'), 'utf8')
    const occurrences = raw.split('\n').filter((l) => l.trim() === '.pi/afk/*').length
    expect(occurrences).toBe(1)
  })

  it('config.json 已存在且无 --force：gitignore 仍先被确保，然后才报错', () => {
    const cwd = tempGitRepo()
    writeFileSync(join(cwd, '.gitignore'), '.pi/afk/\n')
    runInit(cwd) // 首次：写入 config.json + 改写 gitignore

    expect(() => runInit(cwd)).toThrow(/已存在/)
    // gitignore 已确保（解耦）：第二次报错前规则已就位
    const raw = readFileSync(join(cwd, '.gitignore'), 'utf8')
    expect(raw).toContain('!.pi/afk/config.json')
  })
})
