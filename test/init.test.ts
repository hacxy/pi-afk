import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/config.js'
import { runInit } from '../src/init.js'

// execa 保持真实（init.ts 的 git 探测走 execaSync），只 mock 异步 execa（issues.ts 的 gh 调用）
vi.mock('execa', async (importOriginal) => ({
  ...(await importOriginal()),
  execa: vi.fn(),
}))

import { execa } from 'execa'

const mockExeca = vi.mocked(execa)

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

beforeEach(() => {
  vi.clearAllMocks()
  // gh 全部成功：label list 空 → 4 个全建
  mockExeca.mockResolvedValue({ stdout: '' })
})

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('runInit 初始化', () => {
  it('非 git 仓库 → 报错并提示先 git init', async () => {
    const cwd = tempDir()
    await expect(runInit(cwd)).rejects.toThrow(/git init/)
  })

  it('创建 config.json：全量默认值 + baseBranch 探测 origin/HEAD + 补建 4 个 label', async () => {
    const cwd = tempGitRepo()
    execSync('git symbolic-ref refs/remotes/origin/HEAD refs/heads/develop', {
      cwd,
      env: GIT_ENV,
    })

    const result = await runInit(cwd)

    expect(result.baseBranch).toBe('develop')
    expect(result.configPath).toBe(join(cwd, '.pi', 'afk', 'config.json'))
    expect(result.labelsCreated).toEqual([
      'agent:todo',
      'agent:done',
      'agent:failed',
      'agent:merged',
    ])
    const cfg = loadConfig(cwd)
    expect(cfg.baseBranch).toBe('develop')
    expect(cfg.model).toBe('deepseek/deepseek-v4-flash')
    expect(cfg.thinking).toBe('medium')
    expect(cfg.maxParallel).toBe(2)

    // gh 调用：1 次 label list + 4 次 label create（语义色/描述）
    expect(mockExeca).toHaveBeenCalledWith('gh', [
      'label',
      'list',
      '--json',
      'name',
      '--jq',
      '.[].name',
    ])
    expect(mockExeca).toHaveBeenCalledWith('gh', [
      'label',
      'create',
      'agent:todo',
      '--color',
      '#FBCA04',
      '--description',
      'afk: queued for work',
    ])
  })

  it('无 origin/HEAD → baseBranch 回落 main', async () => {
    const cwd = tempGitRepo()

    const result = await runInit(cwd)

    expect(result.baseBranch).toBe('main')
    expect(loadConfig(cwd).baseBranch).toBe('main')
  })

  it('config.json 已存在 → 报错并提示 --force', async () => {
    const cwd = tempGitRepo()
    await runInit(cwd)

    await expect(runInit(cwd)).rejects.toThrow(/已存在/)
    await expect(runInit(cwd)).rejects.toThrow(/--force/)
  })

  it('--force → 覆盖写为默认模板（探测的 baseBranch 生效）', async () => {
    const cwd = tempGitRepo()
    mkdirSync(join(cwd, '.pi', 'afk'), { recursive: true })
    writeFileSync(join(cwd, '.pi', 'afk', 'config.json'), JSON.stringify({ baseBranch: 'develop' }))

    await runInit(cwd, { force: true })

    const cfg = loadConfig(cwd)
    expect(cfg.baseBranch).toBe('main') // 探测无 origin/HEAD → main，覆盖旧的 develop
    expect(cfg.model).toBe('deepseek/deepseek-v4-flash')
  })

  it('模板不含身份键与 installCmd（身份走机器本地 env/global）', async () => {
    const cwd = tempGitRepo()
    await runInit(cwd)

    const raw = readFileSync(join(cwd, '.pi', 'afk', 'config.json'), 'utf8')
    expect(raw).not.toContain('gitAuthor')
    expect(raw).not.toContain('gitEmail')
    expect(raw).not.toContain('installCmd')
  })

  it('无 .gitignore → 创建并写入白名单块（config.json 可入库）', async () => {
    const cwd = tempGitRepo()

    const result = await runInit(cwd)

    expect(result.gitignore).toBe('created')
    const raw = readFileSync(join(cwd, '.gitignore'), 'utf8')
    expect(raw).toContain('.pi/afk/*')
    expect(raw).toContain('!.pi/afk/config.json')
  })

  it('已有整体忽略裸行 .pi/afk/ → 改写为白名单块，其余内容保留', async () => {
    const cwd = tempGitRepo()
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n# afk 运行时产物\n.pi/afk/\ndist/\n')

    const result = await runInit(cwd)

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

  it('已有标记块 → 幂等：不重复追加', async () => {
    const cwd = tempGitRepo()
    await runInit(cwd)

    const result = await runInit(cwd, { force: true }) // 二次运行（--force 跳过已存在报错）

    expect(result.gitignore).toBe('unchanged')
    const raw = readFileSync(join(cwd, '.gitignore'), 'utf8')
    const occurrences = raw.split('\n').filter((l) => l.trim() === '.pi/afk/*').length
    expect(occurrences).toBe(1)
  })

  it('config.json 已存在且无 --force：gitignore 仍先被确保，然后才报错', async () => {
    const cwd = tempGitRepo()
    writeFileSync(join(cwd, '.gitignore'), '.pi/afk/\n')
    await runInit(cwd) // 首次：写入 config.json + 改写 gitignore

    await expect(runInit(cwd)).rejects.toThrow(/已存在/)
    // gitignore 已确保（解耦）：第二次报错前规则已就位
    const raw = readFileSync(join(cwd, '.gitignore'), 'utf8')
    expect(raw).toContain('!.pi/afk/config.json')
  })

  it('label 创建失败 → 初始化不完整，抛错并带指引', async () => {
    const cwd = tempGitRepo()
    mockExeca
      .mockResolvedValueOnce({ stdout: '' }) // label list
      .mockRejectedValueOnce(new Error('gh: Permission denied')) // agent:todo 创建失败

    await expect(runInit(cwd)).rejects.toThrow(/agent:todo[\s\S]*写权限/)
  })
})
