import { defineConfig, defaultExclude } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // 排除 sandcastle 运行时 worktree 快照（.sandcastle/worktrees/ 下的测试副本），只跑真实仓库测试
    exclude: [...defaultExclude, '**/.sandcastle/**'],
  },
})
