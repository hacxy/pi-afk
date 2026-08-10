/**
 * 凭据：一律从环境变量直读（不落盘、不进沙箱）。
 * 不读取任何配置文件 / auth.json。
 */

export function getDeepseekKey(): string | undefined {
  const key = process.env.DEEPSEEK_API_KEY
  return key && key.trim().length > 0 ? key : undefined
}

export function requireDeepseekKey(): string {
  const key = getDeepseekKey()
  if (!key) {
    throw new Error('缺少 DEEPSEEK_API_KEY 环境变量。请先设置：export DEEPSEEK_API_KEY=sk-...')
  }
  return key
}
