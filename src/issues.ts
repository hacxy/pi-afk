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

/** 分支已有 PR（与 gh pr list --json number,state,mergeable 的字段对齐） */
export interface ExistingPr {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  /** GitHub 可合并性：MERGEABLE 干净 / CONFLICTING 冲突 / UNKNOWN 尚未计算（刚建 PR 或已合并） */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null
}

/**
 * 收敛决策（T10 pick 前检查）：issue 是否已有 PR，决定「跳过 / 合并 / 进沙箱」。
 * 纯函数：gh 调用与 autoMerge 开关均可注入。
 */
export type ConvergenceAction =
  | { kind: 'proceed' }
  | { kind: 'skip-merged'; prNumber: number }
  | { kind: 'merge-existing'; prNumber: number }
  | { kind: 'skip-open-clean'; prNumber: number }
  | { kind: 'skip-dirty'; prNumber: number }

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

/** 预同步结果（T11/T13） */
export interface PresyncResult {
  /** 合并干净（分支已并入 origin/main；或预同步被跳过降级） */
  clean: boolean
  /** 冲突文件清单（clean 时为空数组） */
  conflictFiles: string[]
  /** 被合并的 origin/main 提交 SHA（resolve prompt 注入；冲突路径为 MERGE_HEAD，干净路径缺省） */
  mergeSha?: string
}

export interface PublishAndMergeResult {
  /** 创建的 PR。冲突路径（presyncConflict 存在）时未 push/建 PR，为 undefined */
  pr?: PullRequest
  merged: boolean
  /** 预同步冲突信息（冲突路径：冲突现场已保留在沙箱 worktree，由调用方派发 resolve run；
   *   resolve 失败才走 publishConflictFallback 兜底） */
  presyncConflict?: { files: string[]; mergeSha: string }
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

/**
 * 收敛检查数据源（T10）：列出分支的所有 PR（含已合并/已关闭）。
 * gh pr list --head <branch> --state all：按 head 分支名匹配，PR 合并后即使分支被删，
 * head 分支名元数据仍保留，可查到已合并 PR（hacxy.cn #18 事故：merge 后关闭状态传播延迟
 * 导致 issue 列表仍显示 open，这里用 PR 状态兜底判断是否已处理过）。
 */
export async function listPullRequestsForBranch(
  branch: string,
  projectDir: string,
): Promise<ExistingPr[]> {
  const out = await gh(
    ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,mergeable'],
    projectDir,
  )
  return JSON.parse(out) as ExistingPr[]
}

/**
 * 收敛决策（纯函数，可单测）：根据分支已有 PR 与 autoMerge 开关决定本轮行为。
 * 优先级：已合并 PR > open PR（clean/dirty 按 mergeable 区分）> 其余（proceed）。
 * - merged → 不启动沙箱，issue 留言「已由 PR #N 处理，本轮跳过」
 * - open + clean（mergeable !== CONFLICTING）+ autoMerge 开 → 直接合并现有 PR（残留合并闭环）
 * - open + clean + autoMerge 关 → 不启动沙箱，issue 留言「已有 PR #N 待人工合并」
 * - open + dirty（mergeable === CONFLICTING）→ 不启动沙箱，PR 留言冲突说明
 * mergeable 为 UNKNOWN（GitHub 尚未计算，如刚建 PR）按 clean 处理，交给合并重试兜底。
 */
export function decideConvergence(prs: ExistingPr[], autoMerge: boolean): ConvergenceAction {
  const merged = prs.filter((p) => p.state === 'MERGED').sort((a, b) => a.number - b.number)[0]
  if (merged) {
    return { kind: 'skip-merged', prNumber: merged.number }
  }
  const open = prs.filter((p) => p.state === 'OPEN').sort((a, b) => a.number - b.number)[0]
  if (open) {
    if (open.mergeable === 'CONFLICTING') {
      return { kind: 'skip-dirty', prNumber: open.number }
    }
    return autoMerge
      ? { kind: 'merge-existing', prNumber: open.number }
      : { kind: 'skip-open-clean', prNumber: open.number }
  }
  return { kind: 'proceed' }
}

/** 收敛检查 merged：issue 留言「已由 PR #N 处理，本轮跳过」 */
export function buildAlreadyMergedComment(prNumber: number): string {
  return `已由 PR #${prNumber} 处理，本轮跳过。`
}

/** 收敛检查 open+clean + autoMerge 关：issue 留言「已有 PR #N 待人工合并」（不重做、不自动合） */
export function buildPendingManualMergeComment(prNumber: number): string {
  return `检测到已有 PR #${prNumber} 待人工合并。Ralph 本轮跳过：不重做、不自动合并，请人工 review 后合并。`
}

/** 收敛检查 open+dirty：PR 留言说明冲突并跳过本轮（冲突化解由 T11/T13 承接） */
export function buildDirtyPrComment(prNumber: number): string {
  return [
    `### ⚠️ 本 PR（#${prNumber}）存在合并冲突，Ralph 已跳过本轮处理`,
    '',
    '检测到本 PR 与目标分支存在冲突，无法自动合并。Ralph 未重做此 issue，等待人工解决冲突。',
    '',
    '**建议下一步：**',
    '1. 在本地合并最新 main 并解决冲突后推送到本分支',
    '2. 解决冲突后合并本 PR（或关闭 PR 重新派发该 issue）',
  ].join('\n')
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
 * 合并分支已有 PR（收敛检查：open+clean + autoMerge 开）——复用发布流水线的合并 + 30s 重试语义（T8）。
 * 用于「merge 失败的残留 PR，下次 run 自动补合并」场景。
 */
export async function mergeExistingPullRequest(opts: {
  prNumber: number
  projectDir: string
  retryDelayMs?: number
}): Promise<void> {
  await mergeWithRetry(opts)
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
 * 合并冲突 → **保留冲突现场**（不中止、不清理，冲突状态留在沙箱 worktree 供 T13 resolve run
 * 复用 bind-mount 直接可见），返回 presyncConflict（含冲突文件清单与被合并的 main 提交 SHA），
 * 不 push 不建 PR——由调用方派发第二次沙箱 run（resolve run）自动解冲突；resolve 失败才回退
 * publishConflictFallback（push + PR + 留言，不留无声 dirty PR，hacxy.cn #23 事故教训）。
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
    // 冲突：不在此兜底——冲突现场保留在沙箱 worktree（resolve run 复用），兜底延后到 resolve 失败
    return {
      pr: undefined,
      merged: false,
      presyncConflict: {
        files: presync.conflictFiles,
        mergeSha: presync.mergeSha ?? '（未知）',
      },
    }
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
 * 冲突兜底（T13 resolve 失败时调用）：分支照常推送 + 建 PR + PR 留言冲突文件清单，
 * 不 autoMerge（冲突未解的 PR 无法合并）、不抛错（不阻塞循环）。
 * 即 T11 原「冲突路径」兜底行为，独立成函数供 resolve 失败回退复用。
 */
export async function publishConflictFallback(opts: {
  branch: string
  title: string
  body: string
  projectDir: string
  files: string[]
}): Promise<{ pr: PullRequest }> {
  await pushBranch(opts.branch, opts.projectDir)
  const pr = await createPullRequest({
    branch: opts.branch,
    title: opts.title,
    body: opts.body,
    projectDir: opts.projectDir,
  })
  await commentOnPullRequest(
    pr.number,
    buildPresyncConflictComment({ branch: opts.branch, files: opts.files }),
    opts.projectDir,
  )
  return { pr }
}

/**
 * 预同步（T11/T13）：push 前把最新 origin/main 合并进分支（宿主在分支 worktree 内执行 merge，
 * 不涉沙箱凭据）。
 *
 * 为什么用沙箱 worktree 路径（`.sandcastle/worktrees/<branch 斜杠→连字符>`）：sandcastle 在干净
 * run 后会删除 worktree（仅脏状态保留），且分支可能仍被保留的 worktree 检出——先幂等清理再建；
 * 更重要的是 **T13 resolve run 复用同一 worktree**：冲突时保留合并现场（MERGE_HEAD + 未合并路径），
 * sandcastle branch 策略创建 worktree 时发现该路径已有未提交改动，直接复用、bind-mount 可见冲突状态，
 * 无需重建。
 *
 * 合并干净 → 分支头已含 main 最新，返回 { clean: true }（后续验证门校验合并后状态）。
 * 合并冲突 → **不 abort、不删 worktree**（冲突现场保留供 resolve run），返回冲突文件清单 +
 * 被合并提交 SHA（MERGE_HEAD），由调用方派发 resolve run；resolve 失败才走发布流水线兜底。
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

  // 沙箱 worktree 路径（与 sandcastle branch 策略同名命名：斜杠→连字符），resolve run 据此复用
  const tmpDir = sandboxWorktreeDir(projectDir, branch)
  // 幂等清理上次遗留的 worktree（不存在时忽略）
  await git(['worktree', 'remove', '--force', tmpDir], projectDir).catch(() => undefined)
  // --force：分支可能仍被保留的沙箱 worktree 检出（done + 有未提交改动的场景）
  await git(['worktree', 'add', '--force', tmpDir, branch], projectDir)

  const result: PresyncResult = { clean: true, conflictFiles: [] }
  let keepWorktree = false
  try {
    await git(['merge', '--no-edit', 'origin/main'], tmpDir)
  } catch {
    // 区分冲突与其他失败：冲突时工作区存在未合并路径（git diff --diff-filter=U）
    const unmerged = await unmergedFiles(tmpDir)
    if (unmerged.length > 0) {
      // 冲突：保留合并现场（不 abort、不删 worktree），供 T13 resolve run 复用直接可见
      result.clean = false
      result.conflictFiles = unmerged
      result.mergeSha = await mergedSha(tmpDir)
      keepWorktree = true
    } else {
      // 非冲突失败（如 origin/main 缺失）：中止并跳过预同步，行为同现状
      await git(['merge', '--abort'], tmpDir).catch(() => undefined)
    }
  } finally {
    if (!keepWorktree) {
      await git(['worktree', 'remove', '--force', tmpDir], projectDir).catch(() => undefined)
    }
  }
  return result
}

/** 沙箱 worktree 目录（sandcastle branch 策略同名命名：分支斜杠→连字符） */
export function sandboxWorktreeDir(projectDir: string, branch: string): string {
  return join(projectDir, '.sandcastle', 'worktrees', branch.replace(/\//g, '-'))
}

/** 被合并提交 SHA（冲突现场为 MERGE_HEAD）；获取失败降级占位文本（不阻断冲突路径） */
async function mergedSha(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'MERGE_HEAD'], { cwd })
    return stdout.trim() || '（未知）'
  } catch {
    return '（未知）'
  }
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
