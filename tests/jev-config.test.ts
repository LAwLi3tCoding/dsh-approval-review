/**
 * Engine-selection tests: defaults keep the LLM path exactly as it was, and a
 * Jev misconfiguration fails at load instead of silently degrading to the human
 * chain on the first approval.
 * @module dsh-approval-review/tests/jev-config
 */

import { describe, expect, it } from 'vitest'
import { Config, validateReviewerEngine, type Config as ConfigShape } from '../src/config.ts'
import { JEV_ALL_QUESTION_IDS, JEV_QUESTION_IDS } from '../src/jev-questions.ts'

/** Parse a partial config through the real schema so defaults apply. */
function config(overrides: Record<string, unknown> = {}): ConfigShape {
  return (Config as unknown as (value: unknown) => ConfigShape)(overrides)
}

/** Parse with `engine: jev` plus Jev overrides. */
function jevConfig(jev: Record<string, unknown> = {}, reviewer: Record<string, unknown> = {}): ConfigShape {
  return config({
    reviewer: {
      engine: 'jev',
      jev: { allowEgress: true, ...jev },
      ...reviewer,
    },
  })
}

describe('reviewer engine defaults', () => {
  it('defaults to the LLM engine so an existing deployment is unchanged', () => {
    const parsed = config()
    expect(parsed.reviewer.engine).toBe('llm')
  })

  it('defaults the Jev block to the upstream endpoint with egress unacknowledged', () => {
    const parsed = config()
    expect(parsed.reviewer.jev).toMatchObject({
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      apiKeyEnv: 'TYPESAFE_API_KEY',
      timeoutMs: 8000,
      permitProbMin: 0.6,
      prohibitedAt: 0.5,
      scopeBoundedAt: 0.5,
      allowEgress: false,
    })
    expect(parsed.reviewer.jev.rubric).toEqual({})
  })
})

describe('validateReviewerEngine', () => {
  it('says nothing about the LLM engine', () => {
    const problems = validateReviewerEngine(config())
    expect(problems.errors).toEqual([])
    expect(problems.warnings).toEqual([])
  })

  it('accepts a fully acknowledged Jev deployment', () => {
    const problems = validateReviewerEngine(jevConfig())
    // Only the inert-key notes remain: `inspectLocalState` defaults to true, and
    // a Jev deployment must be told it does nothing.
    expect(problems.errors).toEqual([])
    expect(problems.warnings).toHaveLength(1)
    expect(problems.warnings[0]).toContain('inspectLocalState')
  })

  it('refuses to mount while egress is unacknowledged', () => {
    const problems = validateReviewerEngine(jevConfig({ allowEgress: false }))
    expect(problems.errors).toHaveLength(1)
    expect(problems.errors[0]).toContain('allowEgress')
    expect(problems.errors[0]).toContain('https://api.typesafe.ai/v1/systemone')
  })

  it('refuses the subagent mode, which the Jev engine cannot run', () => {
    const problems = validateReviewerEngine(jevConfig({}, { mode: 'subagent' }))
    expect(problems.errors.some(error => error.includes('subagent'))).toBe(true)
  })

  it('refuses a non-loopback http endpoint', () => {
    const problems = validateReviewerEngine(jevConfig({ endpoint: 'http://example.test/v1/systemone' }))
    expect(problems.errors.some(error => error.includes('https'))).toBe(true)
  })

  it('allows a loopback http endpoint for a local gateway', () => {
    const problems = validateReviewerEngine(jevConfig({ endpoint: 'http://127.0.0.1:8080/v1/systemone' }))
    expect(problems.errors).toEqual([])
  })

  it('refuses an unparsable endpoint', () => {
    const problems = validateReviewerEngine(jevConfig({ endpoint: 'not a url' }))
    expect(problems.errors.some(error => error.includes('not a valid URL'))).toBe(true)
  })

  it('refuses an empty apiKeyEnv name', () => {
    const problems = validateReviewerEngine(jevConfig({ apiKeyEnv: '   ' }))
    expect(problems.errors.some(error => error.includes('apiKeyEnv'))).toBe(true)
  })

  it('warns about keys the Jev engine ignores', () => {
    const problems = validateReviewerEngine(jevConfig({}, {
      maxTokens: 512,
      policyText: 'custom policy',
      guidance: 'custom guidance',
      temperature: 0.7,
    }))
    const text = problems.warnings.join('\n')
    expect(text).toContain('maxTokens')
    expect(text).toContain('policyText')
    expect(text).toContain('guidance')
    expect(text).toContain('temperature')
  })

  it('warns about a rubric key that is not a question id', () => {
    const problems = validateReviewerEngine(jevConfig({ rubric: { permit: 'typo, not an id' } }))
    expect(problems.warnings.some(warning => warning.includes('unknown question id'))).toBe(true)
  })

  it('accepts every real question id in the rubric', () => {
    const rubric = Object.fromEntries(JEV_ALL_QUESTION_IDS.map(id => [id, 'override']))
    const problems = validateReviewerEngine(jevConfig({ rubric }))
    expect(problems.warnings.some(warning => warning.includes('unknown question id'))).toBe(false)
  })
})

describe('question ids', () => {
  it('are unique', () => {
    const ids = Object.values(JEV_QUESTION_IDS)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
