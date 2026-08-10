/**
 * 最小验证：Sandcastle + pi + Docker 全链路
 *
 * 验证点：
 * 1. sandcastle 创建/管理 Docker 沙箱
 * 2. pi provider 在沙箱内以 `pi -p --mode json` 驱动
 * 3. pi 能访问 deepseek API（auth 来自 .sandcastle/.env）
 * 4. 流式输出解析 + 结果回收
 *
 * 运行: pnpm verify:sandcastle
 */
import { run, pi } from '@ai-hero/sandcastle'
import { docker } from '@ai-hero/sandcastle/sandboxes/docker'

const result = await run({
  name: 'verify',
  sandbox: docker(),
  agent: pi('deepseek/deepseek-v4-flash'),
  prompt: `你是一个验证脚本。请在沙箱中依次执行以下命令并报告结果：

1. 运行 \`node -e "console.log(1+1)"\`，确认输出是 2
2. 运行 \`whoami\`，报告当前用户
3. 运行 \`pi --version\`，报告 pi 版本
4. 运行 \`ls /home/agent/workspace\`，报告工作目录内容（前 5 项）

最后用一段话总结：你确认了哪些能力正常。不要修改任何文件，不要 git commit，不要创建文件。`,
  maxIterations: 1,
})

console.log('\n=== 验证结果 ===')
console.log('iterations:', result.iterations.length)
console.log('commits:', result.commits.length)
console.log('completionSignal:', result.completionSignal ?? '(none)')
console.log('\n=== agent 输出 ===')
console.log(result.stdout)
