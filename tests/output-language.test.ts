/**
 * Command-output language resolution.
 *
 * This is the one place a harness SETTING decides text this plugin writes into
 * the session transcript, so every branch is pinned here without a harness: the
 * recorded preference, a regional tag, the no-preference fallback, a host with no
 * settings service at all, and the explicit override that short-circuits it.
 * @module dsh-approval-review/tests/output-language
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Config, outputIsZh, type Config as ConfigShape } from '../src/index.ts'

/**
 * Parse a partial config through the real schema so defaults apply. The schema
 * object is itself the parser (`Config(value)`), which is how the Loader calls
 * it; `Schema.resolve` is a different entry point and rejects a partial input.
 */
function config(overrides: Record<string, unknown> = {}): ConfigShape {
  return (Config as unknown as (value: unknown) => ConfigShape)(overrides)
}

/**
 * A host context exposing only the optional settings service this plugin reads.
 * @param locale - the `locale` section's resolved value; omit for no settings service.
 * @returns a context whose `get` answers for `settings` alone.
 */
function host(locale?: unknown): Context {
  const settings = { get: (ns: string) => (ns === 'locale' ? locale : undefined) }
  const services: Record<string, unknown> = locale === undefined ? {} : { settings }
  return { get: (name: string) => services[name] } as unknown as Context
}

describe('outputIsZh', () => {
  it('follows the harness language preference under `auto`', () => {
    expect(outputIsZh(host({ preference: 'zh' }), config())).toBe(true)
    expect(outputIsZh(host({ preference: 'en' }), config())).toBe(false)
  })

  it('matches a regional tag by its primary subtag', () => {
    expect(outputIsZh(host({ preference: 'zh-CN' }), config())).toBe(true)
  })

  it('falls back to English when no preference was ever recorded', () => {
    // Absence delegates the choice to the browser, which the host cannot see, so
    // the host side takes the same English fallback the locale catalog uses.
    expect(outputIsZh(host({}), config())).toBe(false)
  })

  it('falls back to English when the host has no settings service', () => {
    expect(outputIsZh(host(), config())).toBe(false)
  })

  it('lets an explicit language override the setting in both directions', () => {
    expect(outputIsZh(host({ preference: 'en' }), config({ language: 'zh' }))).toBe(true)
    expect(outputIsZh(host({ preference: 'zh' }), config({ language: 'en' }))).toBe(false)
  })
})
