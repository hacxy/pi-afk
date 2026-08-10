import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { LOG_DIR } from './config.js'
import { appendLog } from './log.js'

const execFileAsync = promisify(execFile)

/** GitHub issue（与 gh issue list --json 的字段对齐） */
export interface Issue {
  number: number
  title: string
  body: string
  comments: { author: { login: string }; body: string }[]
}

export interface PullRequest {
  url: string
  number: number
}

export interface PublishAndMergeOptions {
  /** 本地分支名（推送到 origin） */
  branch: string
  /** PR 标题 */
  title: string
  /** PR body（含 Closes #N 时，合并后 GitHub 自动关 issue） */
  body: string
  /** 宿主项目目录（cwd） */
  projectDir: string
  /** 是否自动 squash 合并（AFK 切片语义） */
  autoMerge?: boolean
  /** 合并失败后的重试等待（毫秒，默认 30_000） */
  retryDelayMs?: number
  /** 可选验证命令（验证门）：push 前在分支临时 worktree 执行，非零退出抛 VerifyFailedError 不发版 */
  verifyCommand?: string
}

/** 预同步结果（T11） */
export interface PresyncResult {
  /** 合并干净（分支已并入 origin/main；或预同步被跳过降级） */
  clean: boolean
  /** 冲突文件清单（clean 时为空数组） */
  conflictFiles: string[]
}

export interface PublishAndMergeResult {
  pr: PullRequest
  merged: boolean
  /** 预同步冲突信息（冲突路径：PR 已建 + 已留言、未合并；干净路径为 undefined） */
  presyncConflict?: { files: string[] }
}

/** 验证门失败：发布流水线 push 前验证未通过（调用方据此留言说明并停止本轮，不发版） */
export class VerifyFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerifyFailedError'
  }
}

/** 等待（用全局 setTimeout，便于测试注入假定时器） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function gh(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    })
    return stdout
  } catch (err) {
    const detail = (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message
    throw new Error(`gh ${args[0] ?? ''} 失败: ${detail}`)
  }
}

/**
 * 拉取所有开放 issue（按 labels 过滤：任一命中即 OR；空数组 = 不过滤，拉取全部）。按编号升序。
 * 多标签用逐标签查询 + 按编号去重合并，而非 gh --search：
 * search 走搜索索引有传播延迟（hacxy.cn #18 事故教训），list 端点即时一致。
 */
export async function listAfkIssues(labels: string[]): Promise<Issue[]> {
  const base = ['issue', 'list', '--state', 'open', '--json', 'number,title,body,comments']
  if (labels.length === 0) {
    return (JSON.parse(await gh(base)) as Issue[]).sort((a, b) => a.number - b.number)
  }
  const byNumber = new Map<number, Issue>()
  for (const label of labels) {
    for (const issue of JSON.parse(await gh([...base, '--label', label])) as Issue[]) {
      byNumber.set(issue.number, issue)
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number)
}

export async function commentOnIssue(issueNumber: number, body: string): Promise<void> {
  await gh(['issue', 'comment', String(issueNumber), '--body', body])
}

/** 推送本地分支到 origin（在项目目录执行） */
export async function pushBranch(branch: string, projectDir: string): Promise<void> {
  const { stdout, stderr } = await execFileAsync('git', ['push', '-u', 'origin', branch], {
    cwd: projectDir,
  })
  if (!stdout && !stderr) {
    throw new Error(`git push ${branch} 无输出，可能推送失败`)
  }
}

/** HITL 切片识别：标题/正文含「类型（Type）」字段 + HITL 值（防 label 误用） */
export function isHitlIssue(issue: Pick<Issue, 'body' | 'title'>): boolean {
  const text = `${issue.title}\n${issue.body}`
  // 兼容三种写法：## 类型（Type）\n\nHITL / ## Type\n\nHITL / 类型：HITL
  return /(?:类型\s*[（(]?Type[）)]?|类型|Type)\s*[:：]?\s*\n*\s*HITL/i.test(text)
}

/** 合并 PR（squash + 删分支；PR body 的 Closes #N 会自动关 issue） */
export async function mergePullRequest(opts: {
  prNumber: number
  projectDir: string
}): Promise<void> {
  await gh(['pr', 'merge', String(opts.prNumber), '--squash', '--delete-branch'], opts.projectDir)
}

/**
 * 验证门（issue #22）：为分支创建临时 worktree（分支头的干净检出，随用随删），
 * 在其中执行验证命令（/bin/sh -c）。零退出通过；非零退出抛 VerifyFailedError（含输出）。
 *
 * 不用沙箱 worktree：sandcastle 在成功后（无未提交改动）会清理 worktree，
 * 且其 node_modules 是 Linux 平台产物；临时 worktree 校验的是「将要推送的分支头」
 * 的干净检出状态，语义更强。验证命令需自行准备依赖（如
 * `pnpm install --frozen-lockfile && pnpm typecheck`），与沙箱共享宿主 pnpm store，秒级完成。
 */
async function runVerifyGate(opts: {
  command: string
  branch: string
  projectDir: string
}): Promise<void> {
  const { command, branch, projectDir } = opts
  // 沙箱 worktree 同名命名（斜杠→连字符），前缀 .verify- 避免与 sandcastle 产物冲突
  const tmpDir = join(
    projectDir,
    '.sandcastle',
    'worktrees',
    `.verify-${branch.replace(/\//g, '-')}`,
  )
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectDir })
  // 幂等清理上次遗留的临时 worktree（不存在时忽略）
  await git(['worktree', 'remove', '--force', tmpDir]).catch(() => undefined)
  // --force：分支可能仍被保留的沙箱 worktree 检出（done + 有未提交改动的场景）
  await git(['worktree', 'add', '--force', tmpDir, branch])
  try {
    await execFileAsync('/bin/sh', ['-c', command], { cwd: tmpDir, maxBuffer: 10 * 1024 * 1024 })
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | null; message?: string }
    const output = [e.stdout, e.stderr]
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .join('\n')
      .trim()
    const detail = output || e.message || '（无输出）'
    throw new VerifyFailedError(
      `验证命令「${command}」失败（exit ${e.code ?? '非零'}）：\n${detail}`,
    )
  } finally {
    // 无论成败都清理临时 worktree
    await git(['worktree', 'remove', '--force', tmpDir]).catch(() => undefined)
  }
}

/**
 * 发布流水线（T8）：预同步（T11）→ 验证门（可选）→ 推送分支 → 创建 PR →（可选）squash 合并。
 *
 * 预同步：push 前把最新 origin/main 合并进分支（在分支 worktree 内执行 merge，宿主操作、
 * 不涉沙箱凭据）。合并干净 → 继续验证门 + push + PR + autoMerge，行为与现状一致；
 * 合并冲突 → 中止合并、分支照常推送 + 建 PR + PR 留言冲突清单（不留无声 dirty PR，
 * hacxy.cn #23 事故教训），不 autoMerge（冲突 PR 无法合并）也不抛错（不阻塞循环）。
 *
 * 验证门（issue #22）：配置了 verifyCommand 时，预同步之后、push 之前在分支临时 worktree
 * 执行验证，非零退出即停摆（不发版）。验证的是将要推送的合并后状态。
 * 合并失败先等 retryDelayMs（默认 30 秒）重试一次；重试成功即完成，仍失败则抛出
 * 保留 gh 原始输出的错误。
 */
export async function publishAndMerge(
  opts: PublishAndMergeOptions,
): Promise<PublishAndMergeResult> {
  const presync = await presyncWithMain({ branch: opts.branch, projectDir: opts.projectDir })
  if (!presync.clean) {
    // 冲突兜底：分支照常推送 + 建 PR + PR 留言冲突文件清单，不 autoMerge（待人工处理）
    await pushBranch(opts.branch, opts.projectDir)
    const pr = await createPullRequest({
      branch: opts.branch,
      title: opts.title,
      body: opts.body,
      projectDir: opts.projectDir,
    })
    await commentOnPullRequest(
      pr.number,
      buildPresyncConflictComment({ branch: opts.branch, files: presync.conflictFiles }),
      opts.projectDir,
    )
    return { pr, merged: false, presyncConflict: { files: presync.conflictFiles } }
  }

  if (opts.verifyCommand) {
    await runVerifyGate({
      command: opts.verifyCommand,
      branch: opts.branch,
      projectDir: opts.projectDir,
    })
  }
  await pushBranch(opts.branch, opts.projectDir)
  const pr = await createPullRequest({
    branch: opts.branch,
    title: opts.title,
    body: opts.body,
    projectDir: opts.projectDir,
  })
  if (!opts.autoMerge) {
    return { pr, merged: false }
  }
  await mergeWithRetry({
    prNumber: pr.number,
    projectDir: opts.projectDir,
    retryDelayMs: opts.retryDelayMs,
  })
  return { pr, merged: true }
}

/**
 * 预同步（T11）：push 前把最新 origin/main 合并进分支（宿主在分支 worktree 内执行 merge，
 * 不涉沙箱凭据）。
 *
 * 为什么用临时 worktree：sandcastle 在干净 run 后会删除 worktree（仅脏状态保留），且分支
 * 可能仍被保留的 worktree 检出——与验证门（.verify-）同一模式：在 `.sandcastle/worktrees/`
 * 下建临时 worktree 执行 merge，不碰宿主主工作区。
 *
 * 合并干净 → 分支头已含 main 最新，返回 { clean: true }（后续验证门校验合并后状态）。
 * 合并冲突 → `git merge --abort` 还原分支（头保持在 agent 提交），返回冲突文件清单，
 * 由发布流水线照常推送 + 建 PR + PR 留言兜底。
 * 非冲突失败（如 origin/main 缺失）→ 中止并跳过预同步，行为同现状（不阻断发布）。
 */
async function presyncWithMain(opts: {
  branch: string
  projectDir: string
}): Promise<PresyncResult> {
  const { branch, projectDir } = opts
  const git = (args: string[], cwd: string) => execFileAsync('git', args, { cwd })

  // 刷新 origin/main：agent 运行期间 main 可能已前进。fetch 失败降级用已有 ref（可能过期），记日志不阻断
  try {
    await git(['fetch', 'origin', 'main'], projectDir)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    appendLog(LOG_DIR, { type: 'presync-fetch-failed', branch, message })
  }

  // 临时 worktree（与验证门同名命名：斜杠→连字符，前缀 .presync- 避免与 sandcastle 产物冲突）
  const tmpDir = join(
    projectDir,
    '.sandcastle',
    'worktrees',
    `.presync-${branch.replace(/\//g, '-')}`,
  )
  // 幂等清理上次遗留的临时 worktree（不存在时忽略）
  await git(['worktree', 'remove', '--force', tmpDir], projectDir).catch(() => undefined)
  // --force：分支可能仍被保留的沙箱 worktree 检出（done + 有未提交改动的场景）
  await git(['worktree', 'add', '--force', tmpDir, branch], projectDir)

  const result: PresyncResult = { clean: true, conflictFiles: [] }
  try {
    await git(['merge', '--no-edit', 'origin/main'], tmpDir)
  } catch {
    // 区分冲突与其他失败：冲突时工作区存在未合并路径（git diff --diff-filter=U）
    const unmerged = await unmergedFiles(tmpDir)
    if (unmerged.length > 0) {
      result.clean = false
      result.conflictFiles = unmerged
    }
    // 无论冲突与否都中止合并，还原分支头（冲突：PR 由流水线兜底；其他失败：跳过预同步）
    await git(['merge', '--abort'], tmpDir).catch(() => undefined)
  } finally {
    await git(['worktree', 'remove', '--force', tmpDir], projectDir).catch(() => undefined)
  }
  return result
}

/** 未合并路径清单（冲突文件）：git diff --name-only --diff-filter=U */
async function unmergedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd,
    })
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 在 PR 上留言（冲突兜底：gh pr comment） */
export async function commentOnPullRequest(
  prNumber: number,
  body: string,
  projectDir: string,
): Promise<void> {
  await gh(['pr', 'comment', String(prNumber), '--body', body], projectDir)
}

/** 冲突兜底留言正文：冲突文件清单 + 下一步建议（纯函数，可单测） */
export function buildPresyncConflictComment(opts: { branch: string; files: string[] }): string {
  const fileList =
    opts.files.length > 0
      ? opts.files.map((f) => `- \`${f}\``).join('\n')
      : '- （无法获取冲突文件清单，请查看 PR 的 Files changed）'
  return [
    `### ⚠️ 预同步冲突：未能自动合并 \`origin/main\``,
    '',
    `分支 \`${opts.branch}\` 与 \`origin/main\` 存在冲突。分支已照常推送（含 agent 提交），但**未**并入 main 最新改动，本 PR 当前无法自动合并。`,
    '',
    `**冲突文件（${opts.files.length}）：**`,
    fileList,
    '',
    '**建议下一步：**',
    '1. 人工解决冲突后合并本 PR（或关闭 PR 重新派发该 issue）',
    '2. 解决冲突后可补充提交到本分支',
  ].join('\n')
}

/** 合并 + 重试：失败等 30 秒重试一次；重试仍失败抛错（保留 gh 原始输出） */
async function mergeWithRetry(opts: {
  prNumber: number
  projectDir: string
  retryDelayMs?: number
}): Promise<void> {
  const delay = opts.retryDelayMs ?? 30_000
  try {
    await mergePullRequest({ prNumber: opts.prNumber, projectDir: opts.projectDir })
  } catch {
    // 首次合并失败常见于 PR 刚创建、GitHub 尚未算好可合并性——等 30 秒重试一次
    await sleep(delay)
    await mergePullRequest({ prNumber: opts.prNumber, projectDir: opts.projectDir })
  }
}

/** 用 PR body 里的 "Closes #N" 实现合并时自动关 issue */
export async function createPullRequest(opts: {
  branch: string
  title: string
  body: string
  projectDir: string
}): Promise<PullRequest> {
  const out = await gh(
    [
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      opts.branch,
      '--title',
      opts.title,
      '--body',
      opts.body,
    ],
    opts.projectDir,
  )
  const match = out.match(/https?:\/\/[^\s]+/)
  const url = match ? match[0] : out.trim()
  const numMatch = url.match(/\/pull\/(\d+)/)
  return { url, number: numMatch ? Number(numMatch[1]) : 0 }
}

/**
 * 宿主侧刷新 origin/main（git fetch origin main）。
 * 沙箱 worktree 将从 origin/main 创建（而非过期的本地 HEAD），
 * 避免新 PR 携带已合入 main 的重复提交（hacxy.cn #23 事故）。
 * fetch 失败时抛出错误，由调用方降级为本地 HEAD 基线（不阻断流程）。
 */
export async function fetchOriginMain(projectDir: string): Promise<void> {
  try {
    await execFileAsync('git', ['fetch', 'origin', 'main'], { cwd: projectDir })
  } catch (err) {
    const detail = (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message
    throw new Error(`git fetch origin main 失败: ${detail}`)
  }
}

/** 宿主侧取最近 Ralph 提交（进度锚点） */
export async function recentRalphCommits(projectDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--grep=Ralph:', '-10', '--format=%H %ad %s', '--date=short'],
      { cwd: projectDir },
    )
    return stdout.trim() || '（暂无 Ralph 提交）'
  } catch {
    return '（暂无 Ralph 提交）'
  }
}
