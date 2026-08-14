import { defineConfig, defaultExclude } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // 排除 afk 运行时 worktree 快照（.afk/worktrees/ 下的项目副本），只跑真实仓库测试
    exclude: [...defaultExclude, '**/.afk/**'],
  },
})
