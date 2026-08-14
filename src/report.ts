/**
 * 回报渲染：issue comment 文案的纯函数层。
 * 成功：分支名 + PR 链接 + compare 链接；失败：阶段 + 退出码 + stderr 摘要 + 产物路径 + 重跑提示。
 * 全部纯函数、无副作用，方便确定性测试。
 */

export interface SuccessInfo {
  branch: string
  prUrl: string
  compareUrl: string
}

export interface FailureInfo {
  /** 失败阶段（implementer / git / install / push …） */
  stage: string
  /** 退出码（agent 阶段为 pi 退出码，编排/基础设施失败归 1） */
  exitCode: number
  /** stderr 摘要（原始，尾部截断在调用方做） */
  stderr: string
  /** 编排日志路径（宿主侧） */
  logPath?: string
  /** 会话 JSONL 路径（--mode json 事件流落盘，超时/未起会话时缺省） */
  sessionPath?: string
  /** 失败现场归档路径（.afk/failed/<branch>/，git 阶段失败时缺省） */
  archivePath?: string
  /** 重跑入口 label */
  todoLabel: string
  /** 是否 idle/completion 超时被杀 */
  timedOut?: boolean
}

/** GitHub compare 链接：base...branch */
export function compareUrl(repo: string, base: string, branch: string): string {
  return `https://github.com/${repo}/compare/${base}...${branch}`
}

/** 成功回报：分支名 + PR 链接 + compare 链接 */
export function successComment(info: SuccessInfo): string {
  return [
    '✅ afk 完成',
    '',
    `- 分支：\`${info.branch}\``,
    `- PR：${info.prUrl}`,
    `- compare：${info.compareUrl}`,
  ].join('\n')
}

/** 失败回报：阶段 + 退出码 + stderr 摘要 + 产物路径 + 重跑提示 */
export function failureComment(info: FailureInfo): string {
  const lines: string[] = []
  lines.push(`❌ afk 失败（阶段：${info.stage}）`)
  lines.push('')
  lines.push(`- 退出码：${info.exitCode}`)
  if (info.timedOut) lines.push('- 超时：idle/completion 无活动被杀')
  if (info.stderr.trim()) {
    lines.push('- stderr 摘要：')
    lines.push('')
    lines.push('```')
    lines.push(info.stderr.trim())
    lines.push('```')
  }
  if (info.logPath || info.sessionPath || info.archivePath) {
    lines.push('')
    lines.push('产物路径：')
    if (info.logPath) lines.push(`- 日志：\`${info.logPath}\``)
    if (info.sessionPath) lines.push(`- 会话：\`${info.sessionPath}\``)
    if (info.archivePath) lines.push(`- 失败现场归档：\`${info.archivePath}\``)
  }
  lines.push('')
  lines.push(`> 把 label 改回 \`${info.todoLabel}\` 即可干净重跑。`)
  return lines.join('\n')
}
