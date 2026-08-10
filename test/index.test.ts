import { describe, it, expect } from 'vitest'

import { greet, add } from '../src/index'

describe('greet', () => {
  it('should return greeting', () => {
    expect(greet('World')).toBe('Hello, World!')
  })
})

describe('add', () => {
  it('should add two numbers', () => {
    expect(add(1, 2)).toBe(3)
  })
})
