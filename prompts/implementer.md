# 任务

你是实现 agent。当前在分支 {{BRANCH}}，按下面的计划实现 issue，写代码、验证、提交。

## Issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

{{ISSUE_BODY}}

## 实现计划

{{PLAN}}

## 工作流程

1. **探索** —— 阅读相关源码和测试后再编辑
2. **计划** —— 让改动尽可能小，只实现本 issue 描述的工作
3. **执行** —— 按 TDD 流程：
   - RED：先写失败的测试（覆盖验收标准）
   - GREEN：实现到测试通过
   - REFACTOR：清理，保持测试绿
   - 验收标准即 spec，由你自主决策；重要决策记录在提交信息中
   - 不要为了可测试性随意抽取新函数/新接口（会制造 spaghetti tests）
4. **验证** —— 依赖已由编排层在容器就绪时安装好，**无需自行 install**。提交前运行验证命令，修复所有失败再继续：
   - `pnpm run typecheck`
   - `pnpm run test`
   - `pnpm run lint`
5. **提交** —— 一个 git commit：
   - Conventional Commits 格式（feat:/fix:/refactor:/chore: 等）
   - 结尾带 `afk: issue-{{ISSUE_NUMBER}}`（进度锚点）
   - 说明完成了什么、关键决策、改动文件
   - git 身份已自动注入，无需手动配置

## 约束

- 只实现本 issue 描述的工作，不要顺手改无关代码
- 不要修改 package.json 的依赖版本（除非 issue 明确要求）
- 遇到阻塞（需求不明、依赖缺失、方案冲突）在提交信息中说明，不要强行实现

## 完成

当所有工作完成、测试通过、提交已创建后，输出：

<promise>COMPLETE</promise>
