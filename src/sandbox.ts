/**
 * 沙箱层：docker 容器隔离的执行后端。
 *
 * 边界（与用户共识）：pi 全部阶段 + 依赖安装进容器，git worktree 管理 / push /
 * gh 操作留宿主。容器每 stage 一个、用完即焚；env 只透传白名单（config.sandboxEnv）；
 * --user 映射宿主 uid/gid 保证文件所有权；watchdog 超时由宿主 kill 容器。
 */

import { execa } from 'execa'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Dockerfile 相对项目根路径（init 生成，run 校验） */
export const DOCKERFILE_REL = '.pi/afk/Dockerfile'
export interface SandboxEnvFilter {
  /** 匹配规则：精确名，或 `*` 后缀通配（如 'PI_*' 前缀命中） */
  allowlist: readonly string[]
}

/** 是否命中白名单：精确相等，或规则带 `*` 结尾时前缀匹配 */
function matches(rule: string, key: string): boolean {
  if (rule.endsWith('*')) return key.startsWith(rule.slice(0, -1))
  return rule === key
}

/**
 * 按白名单过滤宿主 env → 容器 env。只放行运行 pi 所需的秘密与设置，
 * GH_TOKEN 等 GitHub 凭据不在默认列表（gh 在宿主侧跑，容器内用不到）。
 */
export function filterSandboxEnv(
  env: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (allowlist.some((rule) => matches(rule, key))) out[key] = value
  }
  return out
}

/**
 * 沙箱镜像 Dockerfile 模板（生成于 `afk init`，落盘 <cwd>/.pi/afk/Dockerfile）。
 * 基于 pi.dev Plain Docker 官方模式：整进程进容器、/workspace 直通宿主 worktree。
 * - node 基底按项目 engines 探测（detectNodeVersion），回落 node:24
 * - pi 版本必须写死（防漂移，镜像 tag 随内容寻址，版本变了重跑 init 即重建）
 * - 内置包管理器：npm（自带）+ pnpm/yarn（npm 全局）+ bun（官方脚本）
 * - git/ripgrep/curl：pi 内置工具依赖 + bun 安装器
 */
export function defaultDockerfile(piVersion: string, nodeMajor = '24'): string {
  const version = piVersion.trim()
  if (!version)
    throw new Error('无法生成沙箱镜像：pi 版本缺失（需要宿主 pi 版本号写死进 Dockerfile）')
  return [
    '# afk 沙箱镜像：pi 全进程 + 项目构建工具链（生成于 afk init，改动后须重跑 afk init 重建）',
    `FROM node:${nodeMajor}-bookworm-slim`,
    '',
    '# pi 内置工具运行依赖',
    'RUN apt-get update \\',
    '  && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep unzip \\',
    '  && rm -rf /var/lib/apt/lists/*',
    '',
    '# 包管理器：npm 自带；pnpm/yarn 走 npm 全局（--force 覆盖镜像内置旧 yarn）；bun 官方脚本',
    'RUN npm install -g --ignore-scripts pnpm && npm install -g --ignore-scripts --force yarn',
    `RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${version}`,
    'RUN curl -fsSL https://bun.sh/install | bash',
    'ENV PATH="/root/.bun/bin:${PATH}"',
    '',
    'WORKDIR /workspace',
    'ENTRYPOINT ["pi"]',
    '',
  ].join('\n')
}

/** 容器基础参数（agent 阶段与 install 容器共用）：--rm/资源限制/--user uid 映射/HOME 宿主目录/挂载 */
export interface ContainerBaseOptions {
  /** 宿主 worktree 绝对路径（挂载为 /workspace） */
  worktree: string
  /** 宿主 HOME 目录绝对路径（挂载为 /tmp/pi-home，容器内 pi settings 跨 stage 缓存） */
  homeDir: string
  /** docker --memory（缺省不限） */
  memory?: string
  /** docker --cpus（缺省不限） */
  cpus?: number
}

export function containerBaseArgs(o: ContainerBaseOptions): string[] {
  const args = ['run', '--rm']
  if (o.memory) args.push('--memory', o.memory)
  if (o.cpus !== undefined) args.push('--cpus', String(o.cpus))
  const uid = process.getuid?.()
  if (uid !== undefined) args.push('--user', `${uid}:${process.getgid?.() ?? uid}`)
  args.push(
    '-e',
    'HOME=/tmp/pi-home',
    '-v',
    `${o.homeDir}:/tmp/pi-home`,
    '-v',
    `${o.worktree}:/workspace`,
  )
  return args
}

/** 沙箱 HOME 宿主目录（容器内 pi 的非工作区状态；宿主创建 → --user 进程天然可写，且 .pi/afk 已 gitignore） */
export function sandboxHomeDir(cwd: string = process.cwd()): string {
  return join(cwd, '.pi', 'afk', 'pi-home')
}

/**
 * 内容寻址镜像 tag：`afk-sandbox-<Dockerfile 内容 sha256 前 16>`。
 * 内容变 → tag 变 → run 校验失配 → 报错提示重跑 afk init（构建入口唯一）。
 */
export function sandboxImageTag(cwd: string): string {
  const file = join(cwd, DOCKERFILE_REL)
  if (!existsSync(file)) {
    throw new Error(`未找到沙箱 Dockerfile（${DOCKERFILE_REL}）：请执行 afk init 生成并构建镜像`)
  }
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
  return `afk-sandbox-${hash}`
}

/**
 * run 启动校验：镜像必须已由 afk init 构建且 tag 匹配当前 Dockerfile。
 * 未构建 / Dockerfile 已改（tag 失配）/ docker 不可用 → 干净报错，绝不自动 build、绝不降级宿主。
 * 返回匹配的镜像 tag。
 */
export async function requireSandboxImage(cwd: string): Promise<string> {
  const tag = sandboxImageTag(cwd)
  try {
    const { exitCode } = await execa('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], {
      reject: false,
    })
    if (exitCode === 0) return tag
    throw new Error(
      `沙箱镜像未构建（${tag}）：请执行 afk init 构建；或已改过 Dockerfile 需重建。` +
        ' 如确需本地运行请显式 --local',
    )
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

/** 支持的最低 / 最高 node 基底主版本（pi 官方模板 node:24，向下兼容到 20） */
const NODE_MIN = 20
const NODE_MAX = 24

/**
 * 探测项目要求的 node 主版本（读 <cwd>/package.json#engines.node 首个整数，clamp [20,24]）。
 * 无 package.json / 无 engines / 不可解析 → 回落 node:24（pi 官方模板）。
 */
export function detectNodeVersion(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      engines?: { node?: string }
    }
    const major = pkg.engines?.node?.match(/\d+/)?.[0]
    if (!major) return '24'
    const n = Number(major)
    if (!Number.isInteger(n)) return '24'
    return String(Math.min(NODE_MAX, Math.max(NODE_MIN, n)))
  } catch {
    return '24'
  }
}
