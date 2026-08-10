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

/** 拉取所有开放且带指定 label 的 issue（按编号升序） */
export async function listAfkIssues(label: string): Promise<Issue[]> {
  const out = await gh([
    'issue',
    'list',
    '--state',
    'open',
    '--label',
    label,
    '--json',
    'number,title,body,comments',
  ])
  const issues = JSON.parse(out) as Issue[]
  return issues.sort((a, b) => a.number - b.number)
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

/** 用 PR body 里的 "Closes #N" 实现合并时自动关 issue（共识 B2） */
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
