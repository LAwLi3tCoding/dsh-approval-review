/**
 * Mount-time diagnostics for the Jev engine.
 *
 * A GUI-launched harness inherits neither the shell's exported variables
 * (`~/.zshenv` is a zsh startup file, and the app is not a zsh process) nor
 * DSH's own credential store (its values are never materialized into
 * `process.env`). A missing key therefore has to be loud at MOUNT, not at the
 * first approval, where it would look like a policy decision to delegate.
 * @module dsh-approval-review/tests/jev-engine-mount
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as ConfigShape } from '../src/config.ts'
import { apply } from '../src/index.ts'

/** A test-only variable name, so the real key is never touched. */
const KEY = 'DSH_APPROVAL_REVIEW_TEST_KEY'

/** Parse a partial config through the real schema so defaults apply. */
function config(overrides: Record<string, unknown> = {}): ConfigShape {
  return (Config as unknown as (value: unknown) => ConfigShape)(overrides)
}

/** Minimal ctx: mounting only reaches these seats before any event fires. */
function stubCtx(warnings: string[], options: { credentials?: boolean } = {}): Context {
  return {
    on: () => {}, inject: () => {},
    get: (name: string) => (name === 'credentials' && options.credentials === true
      ? { resolve: async () => ({ value: 'from-store', source: 'user-env' }) }
      : undefined),
    logger: () => ({
      info: () => {}, debug: () => {}, error: () => {},
      warn: (line: string) => { warnings.push(line) },
    }),
    commands: { register: () => {} },
  } as unknown as Context
}

/** A Jev configuration with egress acknowledged. */
function jevConfig(extra: Record<string, unknown> = {}): ConfigShape {
  return config({ reviewer: { engine: 'jev', jev: { allowEgress: true, apiKeyEnv: KEY, ...extra } } })
}

afterEach(() => { delete process.env[KEY] })

describe('Jev mount diagnostics', () => {
  it('warns when the key is missing, naming the variable and the file that works', () => {
    delete process.env[KEY]
    const warnings: string[] = []
    apply(stubCtx(warnings), jevConfig())
    expect(warnings.some(line => line.includes(KEY) && line.includes('$DSH_HOME/.env'))).toBe(true)
  })

  it('stays quiet about the key when it is present', () => {
    process.env[KEY] = 'present'
    const warnings: string[] = []
    apply(stubCtx(warnings), jevConfig())
    expect(warnings.some(line => line.includes(KEY))).toBe(false)
  })

  it('stays quiet when a credential store is mounted, since it may hold the key', () => {
    // The store resolves asynchronously while `apply` is synchronous, so claiming
    // "missing" here would be a false alarm on the deployment shape the README
    // recommends; an actually unreachable key still fails precisely per review.
    delete process.env[KEY]
    const warnings: string[] = []
    apply(stubCtx(warnings, { credentials: true }), jevConfig())
    expect(warnings.some(line => line.includes('is unset'))).toBe(false)
  })

  it('treats a blank value as missing', () => {
    process.env[KEY] = '   '
    const warnings: string[] = []
    apply(stubCtx(warnings), jevConfig())
    expect(warnings.some(line => line.includes(KEY))).toBe(true)
  })

  it('says nothing at all on the LLM engine', () => {
    const warnings: string[] = []
    apply(stubCtx(warnings), config())
    expect(warnings).toEqual([])
  })

  it('still refuses to mount an unacknowledged Jev configuration', () => {
    const warnings: string[] = []
    expect(() => { apply(stubCtx(warnings), config({ reviewer: { engine: 'jev' } })) })
      .toThrow(/allowEgress/u)
  })
})
