/**
 * Jev engine tests: the request shape, the answer parser, the threshold table,
 * and every failure path. No network: `fetch` is injected.
 * @module dsh-approval-review/tests/jev-reviewer
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildJevRequestBody,
  buildJevState,
  parseJevAnswers,
  runJevReviewer,
  verdictFromJevAnswers,
  type JevAnswers,
  type JevReviewOptions,
} from '../src/jev-reviewer.ts'
import { JEV_QUESTION_IDS } from '../src/jev-questions.ts'
import type { ReviewEvidence } from '../src/reviewer.ts'

const evidence: ReviewEvidence = {
  toolName: 'bash',
  argumentsText: '{"command":"ls -la"}',
  transcript: 'user: list the files',
  userIntent: '["please list the files in this repo"]',
  askReason: 'listing files outside the workspace',
}

/** A well-formed response body; `answers` entries can be replaced per test. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'jev-1.13.0',
    answers: {
      [JEV_QUESTION_IDS.permit]: {
        type: 'choice', choice: 'permit', confidence: 0.9,
        probabilities: { permit: 0.9, refuse: 0.05, uncertain: 0.05 },
      },
      [JEV_QUESTION_IDS.risk]: {
        type: 'choice', choice: 'low', confidence: 0.8,
        probabilities: { low: 0.8, medium: 0.15, high: 0.04, critical: 0.01 },
      },
      [JEV_QUESTION_IDS.authorization]: {
        type: 'choice', choice: 'high', confidence: 0.7,
        probabilities: { high: 0.7, medium: 0.2, low: 0.05, unknown: 0.05 },
      },
      [JEV_QUESTION_IDS.scope]: { type: 'noul', noul: 0.92 },
      [JEV_QUESTION_IDS.prohibitedExfiltration]: { type: 'noul', noul: 0.01 },
      [JEV_QUESTION_IDS.prohibitedCredentialProbing]: { type: 'noul', noul: 0.02 },
      [JEV_QUESTION_IDS.prohibitedSecurityWeakening]: { type: 'noul', noul: 0.01 },
      [JEV_QUESTION_IDS.prohibitedDestruction]: { type: 'noul', noul: 0.03 },
      ...overrides,
    },
  }
}

/** A fetch stub returning one JSON response. */
function respond(body: unknown, init: { status?: number; text?: string } = {}): typeof fetch {
  return (async () => new Response(
    init.text ?? JSON.stringify(body),
    { status: init.status ?? 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
}

/** Options with the endpoint/key defaults a real deployment would have. */
function options(overrides: Partial<JevReviewOptions> = {}): JevReviewOptions {
  return {
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    credential: 'test-key',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    timeoutMs: 1000,
    permitProbMin: 0.6,
    prohibitedAt: 0.5,
    scopeBoundedAt: 0.5,
    rubric: {},
    evidence,
    outputLanguage: 'en',
    exactActionApproval: false,
    ...overrides,
  }
}

/** The validated answers of a well-formed payload, for the pure threshold tests. */
function answersOf(overrides: Record<string, unknown> = {}): JevAnswers {
  const parsed = parseJevAnswers(payload(overrides))
  if ('failure' in parsed) throw new Error(`fixture did not parse: ${parsed.failure}`)
  return parsed.answers
}

const thresholds = { permitProbMin: 0.6, prohibitedAt: 0.5, scopeBoundedAt: 0.5 }

describe('buildJevRequestBody', () => {
  it('asks all eight questions in one request', () => {
    const body = buildJevRequestBody('jev-latest', evidence, {}, false)
    expect(Object.keys(body.questions)).toHaveLength(8)
    expect(body.questions[JEV_QUESTION_IDS.permit]?.type).toBe('choice')
    expect(Object.keys(body.questions[JEV_QUESTION_IDS.permit]?.criteria ?? {})).toEqual(['permit', 'refuse', 'uncertain'])
    expect(Object.keys(body.questions[JEV_QUESTION_IDS.risk]?.criteria ?? {})).toEqual(['low', 'medium', 'high', 'critical'])
    expect(body.questions[JEV_QUESTION_IDS.scope]?.type).toBe('noul')
    expect(body.model).toBe('jev-latest')
  })

  it('carries the evidence as named state fields', () => {
    const state = buildJevState(evidence, true)
    expect(state).toEqual({
      tool: 'bash',
      arguments: '{"command":"ls -la"}',
      ask_reason: 'listing files outside the workspace',
      transcript: 'user: list the files',
      user_intent: '["please list the files in this repo"]',
      host_exact_action_approval: true,
    })
  })

  it('never puts the API key in the body', () => {
    const body = JSON.stringify(buildJevRequestBody('jev-latest', evidence, {}, false))
    expect(body).not.toContain('test-key')
  })

  it('applies a rubric override to exactly one question', () => {
    const body = buildJevRequestBody('jev-latest', evidence, { [JEV_QUESTION_IDS.permit]: 'Custom wording.' }, false)
    expect(body.questions[JEV_QUESTION_IDS.permit]?.instructions).toBe('Custom wording.')
    expect(body.questions[JEV_QUESTION_IDS.risk]?.instructions).not.toBe('Custom wording.')
  })

  it('ignores a blank rubric override', () => {
    const body = buildJevRequestBody('jev-latest', evidence, { [JEV_QUESTION_IDS.permit]: '   ' }, false)
    expect(body.questions[JEV_QUESTION_IDS.permit]?.instructions).toContain('Decide whether this exact action may run now')
  })
})

describe('parseJevAnswers', () => {
  it('reads a complete answer set', () => {
    const answers = answersOf()
    expect(answers.permit).toEqual({ choice: 'permit', probability: 0.9 })
    expect(answers.risk).toBe('low')
    expect(answers.authorization).toBe('high')
    expect(answers.scopeProbability).toBeCloseTo(0.92)
    expect(answers.prohibitions).toHaveLength(4)
  })

  it('rejects a response that is not an object', () => {
    expect(parseJevAnswers('nope')).toEqual({ failure: 'response body was not a JSON object' })
  })

  it('rejects a response with no answers object', () => {
    expect(parseJevAnswers({ model: 'jev-1.13.0' })).toEqual({ failure: 'response has no "answers" object' })
  })

  it('names every missing answer', () => {
    const parsed = parseJevAnswers({ answers: { [JEV_QUESTION_IDS.permit]: { type: 'choice', choice: 'permit' } } })
    expect('failure' in parsed && parsed.failure).toContain('missing answer(s)')
    expect('failure' in parsed && parsed.failure).toContain(JEV_QUESTION_IDS.risk)
  })

  it('rejects an option the question never offered', () => {
    const parsed = parseJevAnswers(payload({
      [JEV_QUESTION_IDS.permit]: { type: 'choice', choice: 'maybe', probabilities: { maybe: 1 } },
    }))
    expect('failure' in parsed && parsed.failure).toContain('unknown option')
  })

  it('rejects a distribution that omits the picked option', () => {
    const parsed = parseJevAnswers(payload({
      [JEV_QUESTION_IDS.permit]: { type: 'choice', choice: 'permit', probabilities: { refuse: 1 } },
    }))
    expect('failure' in parsed && parsed.failure).toContain('no probability for the option it picked')
  })

  it('falls back to confidence when a gateway drops the distribution', () => {
    const parsed = parseJevAnswers(payload({
      [JEV_QUESTION_IDS.permit]: { type: 'choice', choice: 'permit', confidence: 0.75 },
    }))
    expect('answers' in parsed && parsed.answers.permit.probability).toBe(0.75)
  })

  it('rejects a noul outside 0..1', () => {
    const parsed = parseJevAnswers(payload({ [JEV_QUESTION_IDS.scope]: { type: 'noul', noul: 1.4 } }))
    expect('failure' in parsed && parsed.failure).toContain('outside 0..1')
  })

  it('rejects a non-numeric noul', () => {
    const parsed = parseJevAnswers(payload({ [JEV_QUESTION_IDS.scope]: { type: 'noul', noul: 'yes' } }))
    expect('failure' in parsed && parsed.failure).toContain('is not a number')
  })

  it('degrades an unrecognized authorization to unknown instead of failing', () => {
    const answers = answersOf({ [JEV_QUESTION_IDS.authorization]: { type: 'choice', choice: 'medium-ish' } })
    expect(answers.authorization).toBe('unknown')
  })
})

describe('verdictFromJevAnswers', () => {
  it('allows a confident, low-risk, bounded, authorized action', () => {
    const verdict = verdictFromJevAnswers(answersOf(), thresholds, 'en')
    expect(verdict).toMatchObject({ decision: 'allow', risk: 'low', uncertain: false, scopeBounded: true })
    expect(verdict.reason).toContain('Allowed')
  })

  it('lets a prohibition refuse even when permit is confident', () => {
    const verdict = verdictFromJevAnswers(answersOf({
      [JEV_QUESTION_IDS.prohibitedCredentialProbing]: { type: 'noul', noul: 0.91 },
    }), thresholds, 'en')
    expect(verdict.decision).toBe('deny')
    expect(verdict.uncertain).toBe(false)
    expect(verdict.reason).toContain('credential probing')
    expect(verdict.reason).toContain('0.91')
  })

  it('names the strongest prohibition when several apply', () => {
    const verdict = verdictFromJevAnswers(answersOf({
      [JEV_QUESTION_IDS.prohibitedExfiltration]: { type: 'noul', noul: 0.61 },
      [JEV_QUESTION_IDS.prohibitedDestruction]: { type: 'noul', noul: 0.95 },
    }), thresholds, 'en')
    expect(verdict.reason).toContain('catastrophic irreversible destruction')
  })

  it('turns a low permit probability into uncertainty, never a silent allow', () => {
    const verdict = verdictFromJevAnswers(answersOf({
      [JEV_QUESTION_IDS.permit]: { type: 'choice', choice: 'permit', probabilities: { permit: 0.31, refuse: 0.4, uncertain: 0.29 } },
    }), thresholds, 'en')
    expect(verdict).toMatchObject({ decision: 'deny', uncertain: true })
    expect(verdict.reason).toContain('below 0.60')
  })

  it('honours an explicit uncertain answer even at high probability', () => {
    const verdict = verdictFromJevAnswers(answersOf({
      [JEV_QUESTION_IDS.permit]: { type: 'choice', choice: 'uncertain', probabilities: { permit: 0.3, refuse: 0.1, uncertain: 0.95 } },
    }), thresholds, 'en')
    expect(verdict.uncertain).toBe(true)
  })

  it('denies a refuse answer without calling it uncertain', () => {
    const verdict = verdictFromJevAnswers(answersOf({
      [JEV_QUESTION_IDS.permit]: { type: 'choice', choice: 'refuse', probabilities: { permit: 0.05, refuse: 0.93, uncertain: 0.02 } },
    }), thresholds, 'en')
    expect(verdict).toMatchObject({ decision: 'deny', uncertain: false })
    expect(verdict.reason).toContain('refuse')
  })

  it('applies the scope threshold rather than the raw probability', () => {
    const answers = answersOf({ [JEV_QUESTION_IDS.scope]: { type: 'noul', noul: 0.4 } })
    expect(verdictFromJevAnswers(answers, thresholds, 'en').scopeBounded).toBe(false)
    expect(verdictFromJevAnswers(answers, { ...thresholds, scopeBoundedAt: 0.3 }, 'en').scopeBounded).toBe(true)
  })

  it('carries risk and authorization into the verdict for the gates', () => {
    const verdict = verdictFromJevAnswers(answersOf({
      [JEV_QUESTION_IDS.risk]: { type: 'choice', choice: 'high', probabilities: { high: 0.7 } },
      [JEV_QUESTION_IDS.authorization]: { type: 'choice', choice: 'low', probabilities: { low: 0.8 } },
    }), thresholds, 'en')
    expect(verdict).toMatchObject({ risk: 'high', userAuthorization: 'low' })
  })

  it('writes a Chinese reason when the output language is zh', () => {
    const verdict = verdictFromJevAnswers(answersOf(), thresholds, 'zh')
    expect(verdict.reason).toContain('放行')
    expect(verdict.reason).toContain('风险 low')
  })

  it('never emits a newline, which would forge a marker field boundary', () => {
    for (const language of ['en', 'zh'] as const) {
      const verdict = verdictFromJevAnswers(answersOf({
        [JEV_QUESTION_IDS.prohibitedDestruction]: { type: 'noul', noul: 0.9 },
      }), thresholds, language)
      expect(verdict.reason).not.toContain('\n')
    }
  })
})

describe('runJevReviewer', () => {
  it('returns the verdict and the answered model version', async () => {
    const result = await runJevReviewer(options({ fetchImpl: respond(payload()) }))
    expect(result.verdict?.decision).toBe('allow')
    expect(result.answeredModel).toBe('jev-1.13.0')
    expect(result.failure).toBeUndefined()
  })

  it('sends the key as a bearer header and nowhere else', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const spy = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(payload()), { status: 200 })
    }) as unknown as typeof fetch
    await runJevReviewer(options({ fetchImpl: spy, model: 'jev-1.13.0' }))
    expect(calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-key')
    expect(String(calls[0]?.init?.body)).not.toContain('test-key')
    expect(calls[0]?.init?.method).toBe('POST')
  })

  it('fails without dispatching when the key is unset', async () => {
    const spy = vi.fn()
    const result = await runJevReviewer(options({ credential: undefined, fetchImpl: spy as unknown as typeof fetch }))
    expect(result.verdict).toBeUndefined()
    expect(result.failure).toContain('TYPESAFE_API_KEY is not set')
    expect(spy).not.toHaveBeenCalled()
  })

  it('treats a blank key as unset', async () => {
    const result = await runJevReviewer(options({ credential: '   ', fetchImpl: respond(payload()) }))
    expect(result.failure).toContain('is not set')
  })

  it('reports the HTTP status with a bounded detail', async () => {
    const result = await runJevReviewer(options({
      fetchImpl: respond(undefined, { status: 401, text: 'invalid api key\n' }),
    }))
    expect(result.verdict).toBeUndefined()
    expect(result.failure).toBe('jev: HTTP 401: invalid api key')
  })

  it('reports a rate limit as a failure rather than retrying silently', async () => {
    const spy = vi.fn(async () => new Response('slow down', { status: 429 }))
    const result = await runJevReviewer(options({ fetchImpl: spy as unknown as typeof fetch }))
    expect(result.failure).toContain('HTTP 429')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('fails on a 500 without a verdict', async () => {
    const result = await runJevReviewer(options({ fetchImpl: respond(undefined, { status: 500, text: 'boom' }) }))
    expect(result.verdict).toBeUndefined()
    expect(result.failure).toContain('HTTP 500')
  })

  it('fails on a non-JSON body', async () => {
    const result = await runJevReviewer(options({ fetchImpl: respond(undefined, { text: '<html>nope</html>' }) }))
    expect(result.failure).toBe('jev: response body was not JSON')
  })

  it('fails when an answer is missing', async () => {
    const result = await runJevReviewer(options({
      fetchImpl: respond({ answers: { [JEV_QUESTION_IDS.permit]: { type: 'choice', choice: 'permit', probabilities: { permit: 1 } } } }),
    }))
    expect(result.failure).toContain('missing answer(s)')
  })

  it('fails closed on a timeout', async () => {
    const hang = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by deadline')))
    })) as unknown as typeof fetch
    const result = await runJevReviewer(options({ fetchImpl: hang, timeoutMs: 30 }))
    expect(result.verdict).toBeUndefined()
    expect(result.failure).toBe('jev: request timed out after 30 ms')
  })

  it('fails closed on a network error', async () => {
    const boom = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const result = await runJevReviewer(options({ fetchImpl: boom }))
    expect(result.failure).toContain('ECONNREFUSED')
  })

  it('does not dispatch when the caller already cancelled', async () => {
    const spy = vi.fn()
    const controller = new AbortController()
    controller.abort()
    const result = await runJevReviewer(options({ signal: controller.signal, fetchImpl: spy as unknown as typeof fetch }))
    expect(result.failure).toContain('cancelled before dispatch')
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports a mid-flight cancellation as cancelled, not as a verdict', async () => {
    const controller = new AbortController()
    const hang = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')))
    })) as unknown as typeof fetch
    const pending = runJevReviewer(options({ signal: controller.signal, fetchImpl: hang, timeoutMs: 1000 }))
    controller.abort()
    const result = await pending
    expect(result.verdict).toBeUndefined()
    expect(result.failure).toBe('jev: review cancelled')
  })

  it('passes the one-shot human authorization into the state', async () => {
    let sent: string | undefined
    const spy = (async (_url: unknown, init?: RequestInit) => {
      sent = String(init?.body)
      return new Response(JSON.stringify(payload()), { status: 200 })
    }) as unknown as typeof fetch
    await runJevReviewer(options({ fetchImpl: spy, exactActionApproval: true }))
    expect(JSON.parse(sent ?? '{}').state.host_exact_action_approval).toBe(true)
  })
})
