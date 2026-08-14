/**
 * Engine unit tests: pure helpers and connection-independent behavior. Real
 * SSH round-trips are covered by the manual smoke test (docs/).
 */

import { describe, expect, it } from 'vitest'
import { quoteSh } from '../src/engine'

describe('quoteSh', () => {
  it('wraps plain values in single quotes', () => {
    expect(quoteSh('/home/user')).toBe("'/home/user'")
  })

  it('escapes embedded single quotes', () => {
    expect(quoteSh("it's")).toBe("'it'\\''s'")
  })

  it('handles empty strings', () => {
    expect(quoteSh('')).toBe("''")
  })
})

describe('protocol constants', () => {
  it('keeps the API base consistent', async () => {
    const { REMOTE_API, REMOTE_API_BASE } = await import('../src/protocol')
    expect(REMOTE_API.hosts).toBe(`${REMOTE_API_BASE}/hosts`)
    expect(REMOTE_API.terminal).toBe(`${REMOTE_API_BASE}/terminal`)
    expect(REMOTE_API.ls).toBe(`${REMOTE_API_BASE}/fs/ls`)
  })
})
