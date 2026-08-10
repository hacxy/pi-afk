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
