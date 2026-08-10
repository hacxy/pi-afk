import type { Issue } from '../src/issues'

import { describe, it, expect } from 'vitest'

import { pickIssue } from '../src/loop'

const makeIssue = (number: number): Issue => ({
  number,
  title: `issue ${number}`,
  body: 'body',
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
})
