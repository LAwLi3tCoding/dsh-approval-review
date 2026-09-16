/**
 * Pure-policy tests: the highest-risk logic in the plugin is the decision table,
 * so every branch is pinned here without a harness.
 * @module dsh-approval-review/tests/config
 */

import { describe, expect, it } from 'vitest'
import {
  Config,
  applyVerdictGates,
  resolveToolPolicy,
  toolPatternToRegExp,
  type Config as ConfigShape,
} from '../src/config.ts'

/**
 * Parse a partial config through the real schema so defaults apply. The schema
 * object is itself the parser (`Config(value)`), which is how the Loader calls
 * it; `Schema.resolve` is a different entry point and rejects a partial input.
 */
function config(overrides: Record<string, unknown> = {}): ConfigShape {
  return (Config as unknown as (value: unknown) => ConfigShape)(overrides)
}

describe('toolPatternToRegExp', () => {
  it('treats a bare name as an exact, case-insensitive match', () => {
    const pattern = toolPatternToRegExp('bash')
    expect(pattern.test('bash')).toBe(true)
    expect(pattern.test('BASH')).toBe(true)
    expect(pattern.test('bashful')).toBe(false)
  })

  it('expands `*` to a wildcard', () => {
    expect(toolPatternToRegExp('mcp__*').test('mcp__github')).toBe(true)
    expect(toolPatternToRegExp('mcp__*').test('bash')).toBe(false)
  })

  it('escapes regex metacharacters instead of honouring them', () => {
    // A tool name with a dot must not match an arbitrary character.
    expect(toolPatternToRegExp('a.b').test('axb')).toBe(false)
    expect(toolPatternToRegExp('a.b').test('a.b')).toBe(true)
  })
})

describe('resolveToolPolicy', () => {
  it('routes a listed tool to the reviewer', () => {
    const resolved = resolveToolPolicy(config(), 'bash', undefined, '{}')
    expect(resolved.policy).toBe('ai')
    expect(resolved.source).toContain('reviewTools')
  })

  it('routes an unlisted tool to the reviewer under the shipping defaults', () => {
    // The shipping stance: a request is judged, not handed to a human prompt
    // just because its tool name is absent from the table.
    expect(resolveToolPolicy(config({}), 'web_fetch', undefined, '{}')).toMatchObject({ policy: 'ai' })
  })

  it('falls back to defaultPolicy when the table lists no matching tool', () => {
    const resolved = resolveToolPolicy(config({ reviewTools: ['bash'], defaultPolicy: 'human' }), 'read', undefined, '{}')
    expect(resolved.policy).toBe('human')
    expect(resolved.source).toBe('defaultPolicy')
  })

  it('honours an explicit defaultPolicy override', () => {
    const resolved = resolveToolPolicy(config({ reviewTools: [], defaultPolicy: 'never' }), 'read', undefined, '{}')
    expect(resolved.policy).toBe('never')
  })

  it('lets a rule outrank the tool table', () => {
    const resolved = resolveToolPolicy(
      config({
        rules: [{ pattern: 'rm\\s+-rf', policy: 'never', note: 'destructive' }],
      }),
      'bash',
      'please run rm -rf /tmp/x',
      '{}',
    )
    expect(resolved.policy).toBe('never')
    expect(resolved.source).toContain('destructive')
  })

  it('matches a rule against the tool name when field is toolName', () => {
    const resolved = resolveToolPolicy(
      config({ rules: [{ pattern: '^write$', policy: 'ai', field: 'toolName' }] }),
      'write',
      undefined,
      '{}',
    )
    expect(resolved.policy).toBe('ai')
    expect(resolved.source).toContain('toolName')
  })

  it('matches a rule against the arguments when field is arguments', () => {
    const resolved = resolveToolPolicy(
      config({ rules: [{ pattern: 'curl', policy: 'never', field: 'arguments' }] }),
      'bash',
      undefined,
      '{"command":"curl https://example.com"}',
    )
    expect(resolved.policy).toBe('never')
  })

  it('evaluates rules in declaration order', () => {
    const resolved = resolveToolPolicy(
      config({
        rules: [
          { pattern: 'ls', policy: 'ai' },
          { pattern: 'ls', policy: 'never' },
        ],
      }),
      'bash',
      'ls',
      '{}',
    )
    expect(resolved.policy).toBe('ai')
    expect(resolved.source).toContain('rules[0]')
  })

  it('fails loud on an invalid rule pattern', () => {
    expect(() => resolveToolPolicy(
      config({ rules: [{ pattern: '([', policy: 'never' }] }),
      'bash',
      'x',
      '{}',
    )).toThrow(/not a valid regular expression/u)
  })
})

describe('applyVerdictGates', () => {
  it('denies when the reviewer failed and the policy is fail-closed', () => {
    const gate = applyVerdictGates(config({ onReviewerFailure: 'rejected' }), undefined)
    expect(gate.action).toBe('deny')
    expect(gate.note).toContain('fail-closed')
  })

  it('delegates when the reviewer never answered, under the shipping default', () => {
    expect(applyVerdictGates(config({}), undefined).action).toBe('delegate')
  })

  it('refuses when the deployment asks for the fail-closed stance', () => {
    expect(applyVerdictGates(config({ onReviewerFailure: 'rejected' }), undefined).action).toBe('deny')
  })

  it('delegates when the reviewer failed and onReviewerFailure is delegate', () => {
    expect(applyVerdictGates(config({ onReviewerFailure: 'delegate' }), undefined).action).toBe('delegate')
  })

  it('allows when the reviewer failed and onReviewerFailure is allow-once', () => {
    expect(applyVerdictGates(config({ onReviewerFailure: 'allow-once' }), undefined).action).toBe('allow')
  })

  it('delegates an uncertain reviewer by default', () => {
    const gate = applyVerdictGates(config(), { decision: 'deny', risk: 'medium', uncertain: true })
    expect(gate.action).toBe('delegate')
    expect(gate.note).toContain('uncertain')
  })

  it('honours onUncertain allow and deny', () => {
    expect(applyVerdictGates(config({ onUncertain: 'allow' }), { decision: 'deny', risk: 'low', uncertain: true }).action).toBe('allow')
    expect(applyVerdictGates(config({ onUncertain: 'deny' }), { decision: 'allow', risk: 'low', uncertain: true }).action).toBe('deny')
  })

  it('never lets an uncertain verdict inherit the reviewer decision field', () => {
    // An uncertain reviewer reports deny-ish data; the gate must not read it as a
    // confident denial.
    const gate = applyVerdictGates(config({ onUncertain: 'delegate' }), { decision: 'allow', risk: 'low', uncertain: true })
    expect(gate.action).toBe('delegate')
  })

  it('allows a confident allow inside the risk ceiling', () => {
    const gate = applyVerdictGates(config(), { decision: 'allow', risk: 'low', uncertain: false })
    expect(gate.action).toBe('allow')
  })

  it('allows a verdict exactly at the ceiling', () => {
    const gate = applyVerdictGates(config({ maxAutoAllowRisk: 'medium' }), { decision: 'allow', risk: 'medium', uncertain: false })
    expect(gate.action).toBe('allow')
  })

  it('delegates an allow above the risk ceiling by default', () => {
    const gate = applyVerdictGates(config(), { decision: 'allow', risk: 'critical', uncertain: false })
    expect(gate.action).toBe('delegate')
    expect(gate.note).toContain('critical')
  })

  it('honours onRiskExceeded allow and deny', () => {
    expect(applyVerdictGates(config({ onRiskExceeded: 'allow' }), { decision: 'allow', risk: 'critical', uncertain: false }).action).toBe('allow')
    expect(applyVerdictGates(config({ onRiskExceeded: 'deny' }), { decision: 'allow', risk: 'critical', uncertain: false }).action).toBe('deny')
  })

  it('denies a confident denial regardless of risk level', () => {
    for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
      expect(applyVerdictGates(config(), { decision: 'deny', risk, uncertain: false }).action).toBe('deny')
    }
  })
})

describe('Config schema', () => {
  it('parses an empty config into every documented default', () => {
    const resolved = config()
    expect(resolved.enabled).toBe(true)
    expect(resolved.enabledByDefault).toBe(true)
    expect(resolved.reviewTools).toEqual(['*'])
    expect(resolved.defaultPolicy).toBe('ai')
    expect(resolved.rules).toEqual([])
    expect(resolved.reviewer.timeoutMs).toBe(120000)
    expect(resolved.reviewer.maxTokens).toBe(1024)
    expect(resolved.reviewer.temperature).toBe(0)
    expect(resolved.reviewer.argumentMaxChars).toBe(4000)
    expect(resolved.reviewer.argumentsBudgetChars).toBe(16000)
    expect(resolved.context.turns).toBe(2)
    expect(resolved.context.maxChars).toBe(6000)
    expect(resolved.context.includeAuthorizations).toBe(true)
    expect(resolved.context.authorizationMaxChars).toBe(2000)
    expect(resolved.context.authorizationMaxEntries).toBe(8)
    expect(resolved.maxAutoAllowRisk).toBe('medium')
    expect(resolved.onRiskExceeded).toBe('delegate')
    expect(resolved.onUncertain).toBe('delegate')
    expect(resolved.onReviewerFailure).toBe('delegate')
    expect(resolved.budget.maxReviewsPerTurn).toBe(20)
    expect(resolved.budget.onExhausted).toBe('delegate')
    expect(resolved.circuitBreaker.consecutiveDenials).toBe(3)
    expect(resolved.circuitBreaker.windowDenials).toBe(10)
    expect(resolved.circuitBreaker.windowSize).toBe(50)
    expect(resolved.circuitBreaker.action).toBe('delegate')
    expect(resolved.override.ttlMs).toBe(300000)
    expect(resolved.override.maxPending).toBe(10)
    expect(resolved.reasonMaxChars).toBe(2000)
    expect(resolved.feedReasonToModel).toBe(true)
    expect(resolved.language).toBe('en')
  })

  it('keeps a nested override instead of discarding sibling defaults', () => {
    const resolved = config({ reviewer: { model: 'reviewer-x' } })
    expect(resolved.reviewer.model).toBe('reviewer-x')
    expect(resolved.reviewer.timeoutMs).toBe(120000)
  })

  it('rejects an unknown enum value loudly', () => {
    expect(() => config({ defaultPolicy: 'maybe' })).toThrow()
  })

  it('rejects a non-positive reviewer timeout', () => {
    expect(() => config({ reviewer: { timeoutMs: 0 } })).toThrow()
  })
})

describe('reviewer mode and new budgets', () => {
  it('defaults to the subagent reviewer with a read-only tool face', () => {
    const resolved = config()
    expect(resolved.reviewer.mode).toBe('subagent')
    expect(resolved.reviewer.subagentProvider).toBe('fork')
    expect(resolved.reviewer.tools).toEqual(['read', 'glob', 'grep'])
  })

  it('accepts the direct reviewer mode', () => {
    expect(config({ reviewer: { mode: 'direct' } }).reviewer.mode).toBe('direct')
  })

  it('rejects an unknown reviewer mode', () => {
    expect(() => config({ reviewer: { mode: 'sideways' } })).toThrow()
  })

  it('defaults the failure budget and verdict cache', () => {
    const resolved = config()
    expect(resolved.maxFailuresPerTurn).toBe(10)
    expect(resolved.verdictCache.ttlMs).toBe(60000)
    expect(resolved.verdictCache.maxEntries).toBe(256)
  })

  it('allows disabling the verdict cache', () => {
    expect(config({ verdictCache: { ttlMs: 0 } }).verdictCache.ttlMs).toBe(0)
  })
})
