import { describe, it, expect } from 'vitest'

import {
  decideConvergence,
  buildAlreadyMergedComment,
  buildPendingManualMergeComment,
  buildDirtyPrComment,
  type ExistingPr,
} from '../src/issues.js'

/**
 * 收敛检查（T10，issue #24）：pick 前查分支已有 PR，决策「跳过 / 合并 / 进沙箱」。
 * 纯函数测试：gh 调用与 autoMerge 开关均可注入（decideConvergence 只吃结构化输入）。
 */

const pr = (overrides: Partial<ExistingPr>): ExistingPr => ({
  number: 42,
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  ...overrides,
})

describe('decideConvergence', () => {
  it('无 PR（含仅 CLOSED 的 PR）：proceed，正常进沙箱', () => {
    expect(decideConvergence([], false)).toEqual({ kind: 'proceed' })
    expect(decideConvergence([pr({ state: 'CLOSED' })], false)).toEqual({ kind: 'proceed' })
    expect(decideConvergence([pr({ state: 'CLOSED' })], true)).toEqual({ kind: 'proceed' })
  })

  it('已有 merged PR：skip-merged（不启动沙箱），与 autoMerge 开关无关', () => {
    expect(decideConvergence([pr({ number: 29, state: 'MERGED' })], false)).toEqual({
      kind: 'skip-merged',
      prNumber: 29,
    })
    expect(decideConvergence([pr({ number: 29, state: 'MERGED' })], true)).toEqual({
      kind: 'skip-merged',
      prNumber: 29,
    })
  })

  it('merged 优先于 open（同分支同时存在时按已处理跳过）', () => {
    const prs = [
      pr({ number: 41, state: 'OPEN', mergeable: 'MERGEABLE' }),
      pr({ number: 29, state: 'MERGED' }),
    ]
    expect(decideConvergence(prs, true)).toEqual({ kind: 'skip-merged', prNumber: 29 })
  })

  it('open + clean（MERGEABLE）+ autoMerge 开：merge-existing，直接合并现有 PR', () => {
    expect(decideConvergence([pr({ number: 42, mergeable: 'MERGEABLE' })], true)).toEqual({
      kind: 'merge-existing',
      prNumber: 42,
    })
  })

  it('open + clean（MERGEABLE）+ autoMerge 关：skip-open-clean（待人工合并，不合并不重做）', () => {
    expect(decideConvergence([pr({ number: 42, mergeable: 'MERGEABLE' })], false)).toEqual({
      kind: 'skip-open-clean',
      prNumber: 42,
    })
  })

  it('open + dirty（CONFLICTING）：skip-dirty（PR 留言），与 autoMerge 开关无关', () => {
    expect(decideConvergence([pr({ number: 42, mergeable: 'CONFLICTING' })], false)).toEqual({
      kind: 'skip-dirty',
      prNumber: 42,
    })
    expect(decideConvergence([pr({ number: 42, mergeable: 'CONFLICTING' })], true)).toEqual({
      kind: 'skip-dirty',
      prNumber: 42,
    })
  })

  it('open + UNKNOWN（GitHub 尚未计算，如刚建 PR）：按 clean 处理，交给合并重试兜底', () => {
    expect(decideConvergence([pr({ mergeable: 'UNKNOWN' })], true)).toEqual({
      kind: 'merge-existing',
      prNumber: 42,
    })
    expect(decideConvergence([pr({ mergeable: 'UNKNOWN' })], false)).toEqual({
      kind: 'skip-open-clean',
      prNumber: 42,
    })
  })

  it('多个 open PR：取编号最小的（最早创建的）', () => {
    const prs = [
      pr({ number: 45, mergeable: 'MERGEABLE' }),
      pr({ number: 42, mergeable: 'CONFLICTING' }),
      pr({ number: 43, state: 'CLOSED' }),
    ]
    expect(decideConvergence(prs, false)).toEqual({ kind: 'skip-dirty', prNumber: 42 })
  })
})

describe('收敛留言正文（纯函数）', () => {
  it('merged：issue 留言「已由 PR #N 处理，本轮跳过」', () => {
    const body = buildAlreadyMergedComment(29)
    expect(body).toContain('已由 PR #29 处理')
    expect(body).toContain('本轮跳过')
  })

  it('open+clean + autoMerge 关：issue 留言「已有 PR #N 待人工合并」', () => {
    const body = buildPendingManualMergeComment(42)
    expect(body).toContain('已有 PR #42 待人工合并')
    expect(body).toContain('不自动合并')
  })

  it('open+dirty：PR 留言包含 PR 号与冲突说明（不重做，建议人工解决）', () => {
    const body = buildDirtyPrComment(42)
    expect(body).toContain('#42')
    expect(body).toContain('冲突')
    expect(body).toContain('跳过')
    expect(body).toContain('建议下一步')
  })
})
