import { describe, it, expect } from 'vitest'

import { hello } from '../src/index'

describe('hello', () => {
  it('should return a greeting for the given name', () => {
    expect(hello('World')).toBe('Hello, World!')
  })

  it('should return a greeting for an empty name', () => {
    expect(hello('')).toBe('Hello, !')
  })
})
