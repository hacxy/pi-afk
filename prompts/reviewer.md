# 任务

你是 review agent。审查分支 {{BRANCH}} 上刚实现的改动，直接修复问题并提交。无人值守下没有审阅对话，你的输出就是提交本身。

## Issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

## 实现计划

{{PLAN}}

## 要求

1. 运行验证命令确认现状（依赖已由编排层装好，无需自行 install）：
   - `pnpm run typecheck`
   - `pnpm run test`
2. 审查代码：正确性、可读性、是否只改了 issue 相关代码、是否遗漏验收标准
3. 直接修复发现的问题，**保持功能不变**
4. 修复后重新验证，typecheck / test 必须全绿
5. 提交一个 commit：`refactor: review 修复（afk: issue-{{ISSUE_NUMBER}}）`

## 约束

- 不新增功能、不改需求范围，只修审查发现的问题
- 若无需修复，输出 `<promise>COMPLETE</promise>` 即可，不做空提交

## 完成

修复提交后输出：

<promise>COMPLETE</promise>
