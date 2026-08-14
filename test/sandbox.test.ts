import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import {
  ContainerSandbox,
  collectOutput,
  containerName,
  createSandbox,
  installCommand,
  type SandboxOptions,
} from '../src/sandbox.js'

// 凭据注入容器 env，测试隔离：不触发宿主 gh auth / 读 ~/.pi
vi.mock('../src/credentials.js', () => ({
  ghToken: () => 'test-gh-token',
  deepseekApiKey: () => 'test-ds-key',
}))

type FakeChild = EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  exit: (code: number | null, signal: NodeJS.Signals | null) => void
}

/** 假 docker CLI 子进程：PassThrough 流 + 可控 exit（与 executor 测试同一形态） */
function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => child.exit(null, 'SIGTERM'))
  child.exit = (code, signal) => child.emit('exit', code, signal)
  return child
}

/** 假 docker：rm -f 命中即 exit(1)（容器不存在），run -d 输出容器 id */
function makeDockerCli(overrides: Record<string, () => void> = {}) {
  const spawnFn = vi.fn((_cmd: string, args: string[]) => {
    const child = makeFakeChild()
    const key = args[0] ?? ''
    const handler = overrides[key] ?? (() => child.exit(1, null))
    queueMicrotask(handler.bind(null, child))
    return child
  })
  return spawnFn
}

const baseOpts: SandboxOptions = {
  image: 'pi-workspace',
  worktree: '/tmp/wt',
  repoRoot: '/tmp/repo',
  branch: 'afk/issue-52-site-links-nav',
  piHomeDir: '/tmp/pihome',
  sessionDir: '/tmp/sess',
}

describe('containerName 容器名 sanitize', () => {
  it('斜杠与大小写归一为 docker 合法名', () => {
    expect(containerName('afk/issue-52-site-links-nav')).toBe('afk-issue-52-site-links-nav')
    expect(containerName('AFK/Issue-52-SITE')).toBe('afk-issue-52-site')
  })

  it('非法字符（含中文）替换为连字符并去首尾', () => {
    expect(containerName('afk/issue-52-导航链接')).toBe('afk-issue-52')
  })

  it('全非法字符回退 issue（docker 名不能为空）', () => {
    expect(containerName('中文标题')).toBe('issue')
  })

  it('数字开头补字母前缀（docker 名不能数字开头）', () => {
    expect(containerName('123-branch')).toBe('issue-123-branch')
  })
})

describe('installCommand lockfile 检测（onSandboxReady hook）', () => {
  it('pnpm 项目 → pnpm install --frozen-lockfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'afk-lock-'))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    expect(installCommand(dir)).toBe('pnpm install --frozen-lockfile')
  })

  it('npm 项目 → npm ci', () => {
    const dir = mkdtempSync(join(tmpdir(), 'afk-lock-'))
    writeFileSync(join(dir, 'package-lock.json'), '')
    expect(installCommand(dir)).toBe('npm ci')
  })

  it('yarn 项目 → yarn install --immutable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'afk-lock-'))
    writeFileSync(join(dir, 'yarn.lock'), '')
    expect(installCommand(dir)).toBe('yarn install --immutable')
  })

  it('bun 项目 → bun install --frozen-lockfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'afk-lock-'))
    writeFileSync(join(dir, 'bun.lockb'), '')
    expect(installCommand(dir)).toBe('bun install --frozen-lockfile')
  })

  it('无 lockfile → 抛错（无法确定安装命令）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'afk-lock-'))
    expect(() => installCommand(dir)).toThrow(/lockfile/)
  })
})

describe('createSandbox 容器创建（docker run -d）', () => {
  it("先清同名残留，再 run -d 挂载 A' 接缝与凭据，返回容器名", async () => {
    const spawnFn = makeDockerCli({
      rm: (child: FakeChild) => child.exit(1, null), // 残留不存在，正常
      run: (child: FakeChild) => {
        child.stdout.write('abc123def\n')
        child.exit(0, null)
      },
    })

    const sandbox = await createSandbox({ ...baseOpts, spawnFn })
    expect(sandbox.name).toBe('afk-issue-52-site-links-nav')

    const runArgs = spawnFn.mock.calls.find(([, args]) => args[0] === 'run')?.[1] ?? []
    expect(runArgs).toEqual([
      'run',
      '-d',
      '--name',
      'afk-issue-52-site-links-nav',
      '-v',
      '/tmp/wt:/workspace',
      '-v',
      '/workspace/node_modules',
      // A' 接缝（#37）：.git 同路径可写 + hooks/config 只读
      '-v',
      '/tmp/repo/.git:/tmp/repo/.git',
      '-v',
      '/tmp/repo/.git/hooks:/tmp/repo/.git/hooks:ro',
      '-v',
      '/tmp/repo/.git/config:/tmp/repo/.git/config:ro',
      '-v',
      '/tmp/pihome/afk/issue-52-site-links-nav:/home/agent/.pi',
      '-e',
      'GH_TOKEN=test-gh-token',
      '-e',
      'DEEPSEEK_API_KEY=test-ds-key',
      '-e',
      `GIT_AUTHOR_NAME=${process.env.AFK_GIT_AUTHOR ?? 'afk'}`,
      '-e',
      `GIT_AUTHOR_EMAIL=${process.env.AFK_GIT_EMAIL ?? 'afk@hacxy.cn'}`,
      '-e',
      `GIT_COMMITTER_NAME=${process.env.AFK_GIT_AUTHOR ?? 'afk'}`,
      '-e',
      `GIT_COMMITTER_EMAIL=${process.env.AFK_GIT_EMAIL ?? 'afk@hacxy.cn'}`,
      'pi-workspace',
    ])
  })

  it('docker run 失败 → 抛错并给出 stderr 尾段', async () => {
    const spawnFn = makeDockerCli({
      rm: (child: FakeChild) => child.exit(1, null),
      run: (child: FakeChild) => {
        child.stderr.write('Error response from daemon: conflict\n')
        child.exit(1, null)
      },
    })
    await expect(createSandbox({ ...baseOpts, spawnFn })).rejects.toThrow(/conflict/)
  })
})

describe('ContainerSandbox.installDeps（onSandboxReady hook）', () => {
  it('docker exec sh -lc 执行 lockfile 对应安装命令，成功静默', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'afk-wt-'))
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), '')
    const spawnFn = makeDockerCli({
      rm: (child: FakeChild) => child.exit(1, null),
      run: (child: FakeChild) => {
        child.stdout.write('id\n')
        child.exit(0, null)
      },
      exec: (child: FakeChild) => child.exit(0, null),
    })

    const sandbox = await createSandbox({ ...baseOpts, worktree, spawnFn })
    await expect(sandbox.installDeps()).resolves.toBeUndefined()

    const execArgs = spawnFn.mock.calls.find(([, args]) => args[0] === 'exec')?.[1] ?? []
    expect(execArgs).toEqual([
      'exec',
      '-i',
      'afk-issue-52-site-links-nav',
      'sh',
      '-lc',
      'cd /workspace && pnpm install --frozen-lockfile',
    ])
  })

  it('安装失败（非零退出）→ 抛错', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'afk-wt-'))
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), '')
    const spawnFn = makeDockerCli({
      rm: (child: FakeChild) => child.exit(1, null),
      run: (child: FakeChild) => {
        child.stdout.write('id\n')
        child.exit(0, null)
      },
      exec: (child: FakeChild) => {
        child.stderr.write('ERR_PNPM_NO_MATCHING_VERSION\n')
        child.exit(1, null)
      },
    })

    const sandbox = await createSandbox({ ...baseOpts, worktree, spawnFn })
    await expect(sandbox.installDeps()).rejects.toThrow(
      /依赖安装失败.*ERR_PNPM_NO_MATCHING_VERSION/,
    )
  })

  it('installCmd 覆盖 lockfile 检测', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'afk-wt-')) // 空目录，无 lockfile
    const spawnFn = makeDockerCli({
      rm: (child: FakeChild) => child.exit(1, null),
      run: (child: FakeChild) => {
        child.stdout.write('id\n')
        child.exit(0, null)
      },
      exec: (child: FakeChild) => child.exit(0, null),
    })

    const sandbox = await createSandbox({ ...baseOpts, worktree, spawnFn, installCmd: 'make deps' })
    await sandbox.installDeps()
    const execArgs = spawnFn.mock.calls.find(([, args]) => args[0] === 'exec')?.[1] ?? []
    expect(execArgs).toContain('cd /workspace && make deps')
  })
})

describe('ContainerSandbox.runStage（docker exec pi --mode json）', () => {
  it('复用同一容器跑阶段：docker exec -i <name> pi，事件流走共享层并落盘', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'afk-sess-'))
    let execChild: FakeChild
    const spawnFn = vi.fn((_cmd: string, args: string[]) => {
      const child = makeFakeChild()
      if (args[0] === 'exec') {
        // 同步捕获 exec 子进程，测试手动控制事件流与退出
        execChild = child
      } else {
        queueMicrotask(() => {
          if (args[0] === 'run') {
            child.stdout.write('id\n')
            child.exit(0, null)
          } else {
            child.exit(1, null)
          }
        })
      }
      return child
    })

    const sandbox = await createSandbox({ ...baseOpts, sessionDir, spawnFn })
    const promise = sandbox.runStage({
      prompt: '写测试',
      model: 'm',
      stage: 'planner',
      branch: 'afk/issue-52-site-links-nav',
      worktree: '/tmp/wt',
    })

    if (!execChild) throw new Error('docker exec 未同步创建（测试前提）')
    execChild.stdout.write('{"type":"session","id":"s99"}\n')
    execChild.stdout.write('{"type":"agent_start"}\n')
    execChild.stdout.write(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"计划"}}\n',
    )
    execChild.stdout.write('{"type":"agent_settled"}\n')
    execChild.stdout.end()
    execChild.exit(0, null)

    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.sessionId).toBe('s99')
    expect(result.stdout).toBe('计划')
    expect(result.sessionFile).toContain('afk_issue-52-site-links-nav-planner.jsonl')

    const execArgs = spawnFn.mock.calls.find(([, args]) => args[0] === 'exec')?.[1] ?? []
    expect(execArgs[0]).toBe('exec')
    expect(execArgs[1]).toBe('-i')
    expect(execArgs[2]).toBe('afk-issue-52-site-links-nav')
    expect(execArgs.slice(3)).toEqual([
      'pi',
      '-p',
      '--mode',
      'json',
      '--model',
      'm',
      '--thinking',
      'medium',
      '写测试',
    ])
  })
})

describe('ContainerSandbox.destroy', () => {
  it('docker rm -f；可重复调用且 docker 失败也不抛错（finally 安全）', async () => {
    const spawnFn = makeDockerCli({
      rm: (child: FakeChild) => child.exit(0, null),
      run: (child: FakeChild) => {
        child.stdout.write('id\n')
        child.exit(0, null)
      },
    })

    const sandbox = await createSandbox({ ...baseOpts, spawnFn })
    await expect(sandbox.destroy()).resolves.toBeUndefined()
    await expect(sandbox.destroy()).resolves.toBeUndefined()

    const rmCalls = spawnFn.mock.calls.filter(([, args]) => args[0] === 'rm')
    expect(rmCalls.length).toBe(3) // create 时兜底 1 次 + destroy 2 次
    expect(
      rmCalls.every(([, args]) => args[1] === '-f' && args[2] === 'afk-issue-52-site-links-nav'),
    ).toBe(true)
  })
})

describe('collectOutput 命令输出收集', () => {
  it('收集 stdout/stderr 并归一退出码', async () => {
    const spawnFn = vi.fn((_cmd: string, _args: string[]) => {
      const child = makeFakeChild()
      queueMicrotask(() => {
        child.stdout.write('out\n')
        child.stderr.write('err\n')
        child.exit(2, null)
      })
      return child
    })
    const { stdout, stderr, exitCode } = await collectOutput(spawnFn, 'docker', ['ps'])
    expect(stdout).toBe('out\n')
    expect(stderr).toBe('err\n')
    expect(exitCode).toBe(2)
  })
})

describe('ContainerSandbox 构造与接口形状', () => {
  it('可直接构造（不经 createSandbox），name 透传', () => {
    const sandbox = new ContainerSandbox(baseOpts, 'afk-x', 'id-1')
    expect(sandbox.name).toBe('afk-x')
    expect(typeof sandbox.installDeps).toBe('function')
    expect(typeof sandbox.runStage).toBe('function')
    expect(typeof sandbox.destroy).toBe('function')
  })
})
