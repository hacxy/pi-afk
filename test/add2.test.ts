import { describe, it, expect } from 'vitest'

import { add2 } from '../src/index'

describe('add2', () => {
  it('返回两个数字之和', () => {
    expect(add2(1, 2)).toBe(3)
    expect(add2(-1, 1)).toBe(0)
    expect(add2(0, 0)).toBe(0)
    expect(add2(2.5, 1.5)).toBe(4)
  })
})
