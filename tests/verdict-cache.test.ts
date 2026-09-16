/**
 * Verdict-cache tests. The cache decides whether a reviewer is even called, so a
 * bug here either bills a model call for every repeat or — worse — reuses a
 * verdict that was never valid for this action.
 * @module dsh-approval-review/tests/verdict-cache
 */

import { describe, expect, it } from 'vitest'
import { VerdictCache } from '../src/verdict-cache.ts'
import type { ReviewVerdict } from '../src/review-types.ts'

const ALLOW: ReviewVerdict = { decision: 'allow', risk: 'low', reason: 'routine', uncertain: false }
const DENY: ReviewVerdict = { decision: 'deny', risk: 'high', reason: 'exfil', uncertain: false }

describe('VerdictCache.fingerprint', () => {
  it('is stable for identical input', () => {
    expect(VerdictCache.fingerprint('bash', '{"a":1}')).toBe(VerdictCache.fingerprint('bash', '{"a":1}'))
  })

  it('separates different tools', () => {
    expect(VerdictCache.fingerprint('bash', '{}')).not.toBe(VerdictCache.fingerprint('write', '{}'))
  })

  it('separates different argument bytes', () => {
    expect(VerdictCache.fingerprint('bash', '{"a":1}')).not.toBe(VerdictCache.fingerprint('bash', '{"a":2}'))
  })

  it('treats key order as significant, because the command may differ', () => {
    expect(VerdictCache.fingerprint('bash', '{"a":1,"b":2}'))
      .not.toBe(VerdictCache.fingerprint('bash', '{"b":2,"a":1}'))
  })

  it('cannot be confused by a delimiter inside a field', () => {
    // "a" + \0 + "b\0c" must not collide with "a\0b" + \0 + "c".
    expect(VerdictCache.fingerprint('a', 'b\0c')).not.toBe(VerdictCache.fingerprint('a\0b', 'c'))
  })

  it('separates a retry that presents an authorization from one that does not', () => {
    // A one-shot `/approval-review approve` exists to overturn a denial. Keyed on
    // the action alone, the authorized retry lands on the cached copy of the very
    // denial the human just overrode — the grant would be silently ignored.
    expect(VerdictCache.fingerprint('edit', '{"p":"a"}', 'edit#r1'))
      .not.toBe(VerdictCache.fingerprint('edit', '{"p":"a"}'))
  })

  it('leaves the pre-authorization fingerprint unchanged, so an upgrade does not cold-start the cache', () => {
    expect(VerdictCache.fingerprint('bash', '{"a":1}')).toBe(VerdictCache.fingerprint('bash', '{"a":1}', ''))
  })
})

describe('VerdictCache', () => {
  it('is disabled at a zero TTL', () => {
    const cache = new VerdictCache(0, 10)
    expect(cache.enabled).toBe(false)
    cache.put('k', ALLOW)
    expect(cache.get('k')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('is disabled at a zero capacity', () => {
    const cache = new VerdictCache(1000, 0)
    expect(cache.enabled).toBe(false)
    cache.put('k', ALLOW)
    expect(cache.get('k')).toBeUndefined()
  })

  it('returns a stored verdict and counts the hit', () => {
    const cache = new VerdictCache(1000, 10)
    cache.put('k', DENY, 100)
    expect(cache.get('k', 200)).toEqual(DENY)
    expect(cache.hitCount).toBe(1)
    expect(cache.missCount).toBe(0)
  })

  it('counts a miss for an unknown key', () => {
    const cache = new VerdictCache(1000, 10)
    expect(cache.get('nope')).toBeUndefined()
    expect(cache.missCount).toBe(1)
  })

  it('expires an entry past its TTL and counts it as a miss', () => {
    const cache = new VerdictCache(100, 10)
    cache.put('k', ALLOW, 0)
    expect(cache.get('k', 100)).toBeUndefined()
    expect(cache.missCount).toBe(1)
    expect(cache.size).toBe(0)
  })

  it('keeps an entry exactly at its expiry instant', () => {
    const cache = new VerdictCache(100, 10)
    cache.put('k', ALLOW, 0)
    expect(cache.get('k', 99)).toEqual(ALLOW)
  })

  it('evicts the oldest entry past capacity', () => {
    const cache = new VerdictCache(1000, 2)
    cache.put('a', ALLOW, 0)
    cache.put('b', ALLOW, 0)
    cache.put('c', DENY, 0)
    expect(cache.size).toBe(2)
    expect(cache.get('a', 1)).toBeUndefined()
    expect(cache.get('b', 1)).toEqual(ALLOW)
    expect(cache.get('c', 1)).toEqual(DENY)
  })

  it('promotes a read entry so it survives eviction', () => {
    const cache = new VerdictCache(1000, 2)
    cache.put('a', ALLOW, 0)
    cache.put('b', DENY, 0)
    // Touch `a`, making `b` the oldest.
    expect(cache.get('a', 1)).toEqual(ALLOW)
    cache.put('c', ALLOW, 2)
    expect(cache.get('a', 3)).toEqual(ALLOW)
    expect(cache.get('b', 3)).toBeUndefined()
  })

  it('clears every entry but keeps the counters', () => {
    const cache = new VerdictCache(1000, 10)
    cache.put('a', ALLOW)
    cache.get('a')
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.hitCount).toBe(1)
  })
})
