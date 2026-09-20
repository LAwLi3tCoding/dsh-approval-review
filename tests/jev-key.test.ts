/**
 * Jev key resolution tests.
 *
 * The seam-first order is what makes "store the key in the harness credential
 * UI" a complete setup for any installer, so the fallback chain is pinned here
 * without touching a real credential store or the network.
 * @module dsh-approval-review/tests/jev-key
 */

import { describe, expect, it } from 'vitest'
import { readCredentialSeam, resolveJevApiKey, type CredentialSeamLike } from '../src/jev-key.ts'

/** A seam that resolves to one fixed value. */
function seamReturning(hit: unknown): CredentialSeamLike {
  return { resolve: async () => hit }
}

/** A seam that fails, as an unreachable store would. */
function seamThrowing(message: string): CredentialSeamLike {
  return { resolve: async () => { throw new Error(message) } }
}

describe('readCredentialSeam', () => {
  it('accepts an object exposing a resolve function', () => {
    expect(readCredentialSeam({ resolve: async () => undefined })).toBeDefined()
  })

  it('rejects anything that is not a seam', () => {
    expect(readCredentialSeam(undefined)).toBeUndefined()
    expect(readCredentialSeam(null)).toBeUndefined()
    expect(readCredentialSeam({})).toBeUndefined()
    expect(readCredentialSeam({ resolve: 'nope' })).toBeUndefined()
  })

  it('calls the method with its own receiver', async () => {
    const holder = {
      value: 'bound',
      resolve(this: { value: string }, ref: string) {
        return Promise.resolve({ value: `${ref}:${this.value}` })
      },
    }
    await expect(readCredentialSeam(holder)?.resolve('X')).resolves.toEqual({ value: 'X:bound' })
  })
})

describe('resolveJevApiKey', () => {
  it('prefers the credential seam and reports where it came from', async () => {
    const hit = await resolveJevApiKey({
      envName: 'K',
      seam: seamReturning({ value: 'from-seam', source: 'user-env' }),
      env: { K: 'from-env' },
    })
    expect(hit).toEqual({ key: 'from-seam', source: 'credentials', detail: 'user-env' })
  })

  it('falls back to the environment when the seam has no value', async () => {
    expect(await resolveJevApiKey({ envName: 'K', seam: seamReturning(undefined), env: { K: 'from-env' } }))
      .toEqual({ key: 'from-env', source: 'process-env' })
  })

  it('falls back to the environment when the seam throws, keeping the reason', async () => {
    const hit = await resolveJevApiKey({ envName: 'K', seam: seamThrowing('store offline'), env: { K: 'from-env' } })
    expect(hit.key).toBe('from-env')
    expect(hit.source).toBe('process-env')
    expect(hit.failure).toContain('store offline')
  })

  it('reports none when neither layer has the key', async () => {
    expect(await resolveJevApiKey({ envName: 'K', seam: seamReturning(undefined), env: {} }))
      .toEqual({ source: 'none' })
  })

  it('treats blank values as absent in both layers', async () => {
    const hit = await resolveJevApiKey({ envName: 'K', seam: seamReturning({ value: '   ' }), env: { K: '' } })
    expect(hit.source).toBe('none')
    expect(hit.key).toBeUndefined()
  })

  it('works with no seam at all, which is the older deployment shape', async () => {
    expect(await resolveJevApiKey({ envName: 'K', env: { K: 'x' } })).toEqual({ key: 'x', source: 'process-env' })
  })

  it('ignores a seam hit that is not an object', async () => {
    expect((await resolveJevApiKey({ envName: 'K', seam: seamReturning('plain'), env: { K: 'x' } })).source)
      .toBe('process-env')
  })
})
