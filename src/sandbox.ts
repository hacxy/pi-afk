import { run, pi, Output } from '@ai-hero/sandcastle'
import { docker } from '@ai-hero/sandcastle/sandboxes/docker'
import { z } from 'zod'

/**
 * 结构化输出协议（共识 B1）：
 * agent 在 <outcome> 标签中输出合法 JSON，宿主据此决定后续动作。
 * 校验失败时 sandcastle 会自动重试（resume session + 反馈错误）。
 */
export const outcomeSchema = z.object({
  status: z.enum(['done', 'blocked', 'skipped']),
  summary: z.string(),
  needsHuman: z.boolean().optional(),
})

export type Outcome = z.infer<typeof outcomeSchema>

export interface RunIssueOptions {
  /** 沙箱镜像名 */
  image: string
  /** pi 模型（provider/model 格式） */
  model: string
  /** deepseek key（注入容器 env） */
  deepseekKey: string
  /** 宿主项目目录（git 操作与 worktree 锚点） */
  projectDir: string
  /** 工作分支名，如 agent/issue-12 */
  branch: string
  /** prompt 模板绝对路径 */
  promptFile: string
  /** 注入 prompt 的参数 */
  promptArgs: Record<string, string>
  /** 运行日志路径（全局 ~/.afk/logs/ 下，共识 F2） */
  logPath: string
  /** 完成信号 */
  completionSignal: string
  /** 无输出超时（秒） */
  idleTimeoutSeconds?: number
}

export interface RunIssueResult {
  outcome: Outcome
  commits: { sha: string }[]
  stdout: string
}

/**
 * 在沙箱中执行单个 issue。
 * - 每个 issue 独立分支（branch 模式，共识 A2）
 * - 沙箱零凭据（只注入 DEEPSEEK_API_KEY，保守派）
 * - agent 只提交，push/PR/关 issue 由宿主完成
 */
export async function runIssueInSandbox(opts: RunIssueOptions): Promise<RunIssueResult> {
  const result = await run({
    name: opts.branch,
    cwd: opts.projectDir,
    sandbox: docker({
      imageName: opts.image,
      env: { DEEPSEEK_API_KEY: opts.deepseekKey },
    }),
    agent: pi(opts.model),
    branchStrategy: { type: 'branch', branch: opts.branch },
    // 复用宿主 node_modules（避免沙箱内全量重装依赖）
    copyToWorktree: ['node_modules'],
    promptFile: opts.promptFile,
    promptArgs: opts.promptArgs,
    completionSignal: opts.completionSignal,
    output: Output.object({ tag: 'outcome', schema: outcomeSchema }),
    maxIterations: 1,
    logging: { type: 'file', path: opts.logPath },
    idleTimeoutSeconds: opts.idleTimeoutSeconds ?? 600,
  })

  return {
    outcome: result.output as Outcome,
    commits: result.commits,
    stdout: result.stdout,
  }
}
