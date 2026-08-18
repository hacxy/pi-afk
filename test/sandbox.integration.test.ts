import { execa, execaSync } from 'execa'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { containerBaseArgs } from '../src/sandbox.js'

/**
 * 真 docker 集成测试：验证沙箱参数组合在真实 daemon 上的承诺。
 * 无 docker（CI）→ skip；镜像用官方 node slim（比沙箱镜像轻，机制等价：同挂载/同 user）。
 */
const dockerOk = (() => {
  try {
    return (
      execaSync('docker', ['version', '--format', '{{.Server.Version}}'], {
        reject: false,
        timeout: 5000,
      }).exitCode === 0
    )
  } catch {
    return false
  }
})()

const IMAGE = 'node:24-bookworm-slim'
let dirs: string[] = []

function tempWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'afk-int-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe.skipIf(!dockerOk)('沙箱容器机制（真 docker）', () => {
  it('--user 映射宿主 uid：容器内写文件，宿主侧 owner = 当前用户（文件所有权一致）', async () => {
    const wt = tempWorktree()
    const uid = process.getuid()
    if (uid === undefined) return // 平台无 uid 概念（win）→ 跳过
    const args = [
      ...containerBaseArgs({ worktree: wt }),
      '-w',
      '/workspace',
      IMAGE,
      'sh',
      '-c',
      'echo x > created-by-container',
    ]

    const { exitCode } = await execa('docker', args, { reject: false, timeout: 120000 })
    expect(exitCode).toBe(0)
    const st = statSync(join(wt, 'created-by-container'))
    expect(st.uid).toBe(uid) // 宿主能读写后续 git/gh 操作不撞权限
  })

  it('worktree 挂载双向直通：宿主预置文件容器可见（agent 读写即宿主读写）', async () => {
    const wt = tempWorktree()
    writeFileSync(join(wt, 'host-file.txt'), 'from-host')
    const args = [
      ...containerBaseArgs({ worktree: wt }),
      '-w',
      '/workspace',
      IMAGE,
      'sh',
      '-c',
      'cat host-file.txt',
    ]

    const { exitCode, stdout } = await execa('docker', args, { reject: false, timeout: 120000 })
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('from-host')
  })

  it('HOME 宿主目录持久：容器 A 写 /tmp/pi-home，容器 B 读到（跨 stage settings 缓存，--user 可写）', async () => {
    const mkHome = (): string => {
      const home = mkdtempSync(join(tmpdir(), 'afk-int-home-'))
      dirs.push(home)
      return home
    }
    const args = (home: string, cmd: string) => [
      ...containerBaseArgs({ worktree: tempWorktree(), homeDir: home }),
      '-w',
      '/workspace',
      IMAGE,
      '/bin/sh',
      '-c',
      cmd,
    ]
    const home = mkHome()
    const a = await execa('docker', args(home, 'echo persisted > /tmp/pi-home/settings.txt'), {
      reject: false,
      timeout: 120000,
    })
    expect(a.exitCode).toBe(0) // --user 进程对宿主目录有写权限（命名卷 root 属主坑已避开）
    const b = await execa('docker', args(home, 'cat /tmp/pi-home/settings.txt'), {
      reject: false,
      timeout: 120000,
    })
    expect(b.exitCode).toBe(0)
    expect(b.stdout.trim()).toBe('persisted')
  })

  it('容器内进程身份非 root（--user 生效）：id -u 输出宿主 uid', async () => {
    const uid = process.getuid()
    if (uid === undefined) return
    const args = [
      ...containerBaseArgs({ worktree: tempWorktree() }),
      '-w',
      '/workspace',
      IMAGE,
      'id',
      '-u',
    ]

    const { exitCode, stdout } = await execa('docker', args, { reject: false, timeout: 120000 })
    expect(exitCode).toBe(0)
    expect(Number(stdout.trim())).toBe(uid)
  })
})
