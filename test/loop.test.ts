import type { Issue } from '../src/issues'

import { describe, it, expect } from 'vitest'

import { isHitlIssue } from '../src/issues'
import { pickIssue } from '../src/loop'

const makeIssue = (number: number, body = 'body'): Issue => ({
  number,
  title: `issue ${number}`,
  body,
  comments: [],
})

describe('pickIssue', () => {
  it('返回编号最小的开放 issue', () => {
    const issues = [makeIssue(5), makeIssue(3), makeIssue(8)]
    expect(pickIssue(issues, new Set())?.number).toBe(3)
  })

  it('跳过集合内的 issue', () => {
    const issues = [makeIssue(5), makeIssue(3), makeIssue(8)]
    expect(pickIssue(issues, new Set([3]))?.number).toBe(5)
    expect(pickIssue(issues, new Set([3, 5, 8]))).toBeNull()
  })

  it('空列表返回 null', () => {
    expect(pickIssue([], new Set())).toBeNull()
  })

  it('跳过 HITL 切片（防 label 误用）', () => {
    const afk = makeIssue(1)
    const hitl = makeIssue(2, '## 类型（Type）\n\nHITL')
    const issues = [hitl, afk]
    expect(pickIssue(issues, new Set())?.number).toBe(1)
    expect(pickIssue([hitl], new Set())).toBeNull()
  })
})

describe('isHitlIssue', () => {
  it('识别中文/英文 HITL 标记', () => {
    expect(isHitlIssue(makeIssue(1, '## 类型（Type）\n\nHITL'))).toBe(true)
    expect(isHitlIssue(makeIssue(2, '## Type\n\nHITL'))).toBe(true)
    expect(isHitlIssue(makeIssue(3, '## 类型（Type）\n\nAFK'))).toBe(false)
    expect(isHitlIssue(makeIssue(4, '普通 issue'))).toBe(false)
  })
})
