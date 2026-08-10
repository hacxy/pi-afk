import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
}

export interface PublishAndMergeResult {
  pr: PullRequest
  merged: boolean
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
 * 发布流水线（T8）：推送分支 → 创建 PR →（可选）squash 合并。
 * 合并失败先等 retryDelayMs（默认 30 秒）重试一次；重试成功即完成，仍失败则抛出
 * 保留 gh 原始输出的错误。后续合并行为（预同步/验证门/冲突兜底）都插在这唯一的出口。
 */
export async function publishAndMerge(
  opts: PublishAndMergeOptions,
): Promise<PublishAndMergeResult> {
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
