/**
 * Reviewer-selection tests.
 *
 * The picker offers one list spanning both engines, so a selection carries its
 * engine. These tests pin that contract, plus the two guards a session must not
 * be able to talk its way past: the deployment's egress consent, and the shape the
 * Jev endpoint accepts.
 * @module dsh-approval-review/tests/model-override
 */

import { describe, expect, it } from 'vitest'
import { effectiveReviewerModel, type ReviewerEngineName } from '../src/model-override.ts'

/** Resolve with the given deployment engine and its matching defaults. */
function resolve(input: {
  readonly engine: ReviewerEngineName
  readonly overrideEngine?: ReviewerEngineName
  readonly overrideProvider?: string
  readonly overrideModel?: string
  readonly jevPermitted?: boolean
}): ReturnType<typeof effectiveReviewerModel> {
  const jevDeployment = input.engine === 'jev'
  return effectiveReviewerModel({
    ...input,
    defaultProvider: jevDeployment ? 'typesafe' : 'mtfriday',
    defaultModel: jevDeployment ? 'jev-latest' : 'deepseek-v4-flash',
    jevPermitted: input.jevPermitted ?? jevDeployment,
  })
}

describe('deployment default', () => {
  it('uses the LLM route when the deployment chose llm', () => {
    expect(resolve({ engine: 'llm' })).toEqual({ engine: 'llm', provider: 'mtfriday', model: 'deepseek-v4-flash' })
  })

  it('uses the Jev model when the deployment chose jev', () => {
    expect(resolve({ engine: 'jev' })).toEqual({ engine: 'jev', provider: 'typesafe', model: 'jev-latest' })
  })
})

describe('a selection that carries its engine', () => {
  it('switches a Jev deployment to the LLM route the selection names', () => {
    // The complaint this fixes: the picker listed `provider/model` rows, choosing
    // one did nothing, and the header kept showing the Jev model.
    expect(resolve({
      engine: 'jev', overrideEngine: 'llm',
      overrideProvider: 'deepseek-official', overrideModel: 'deepseek-v4-flash',
    })).toEqual({ engine: 'llm', provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('switches an LLM deployment to Jev when egress was acknowledged', () => {
    expect(resolve({ engine: 'llm', overrideEngine: 'jev', overrideModel: 'jev-1.13.0', jevPermitted: true }))
      .toEqual({ engine: 'jev', provider: 'typesafe', model: 'jev-1.13.0' })
  })

  it('accepts the display label on the model half', () => {
    expect(resolve({ engine: 'jev', overrideEngine: 'jev', overrideModel: 'typesafe/jev-preview' }))
      .toEqual({ engine: 'jev', provider: 'typesafe', model: 'jev-preview' })
  })

  it('keeps the engine in force for a bare model id', () => {
    expect(resolve({ engine: 'jev', overrideModel: 'jev-1.13.0' }))
      .toEqual({ engine: 'jev', provider: 'typesafe', model: 'jev-1.13.0' })
    expect(resolve({ engine: 'llm', overrideModel: 'deepseek-v4-pro' }))
      .toEqual({ engine: 'llm', provider: 'mtfriday', model: 'deepseek-v4-pro' })
  })
})

describe('guards', () => {
  it('refuses a Jev selection the deployment never consented to', () => {
    expect(resolve({ engine: 'llm', overrideEngine: 'jev', overrideModel: 'jev-latest' })).toEqual({
      engine: 'llm',
      provider: 'mtfriday',
      model: 'deepseek-v4-flash',
      rejectedOverride: 'typesafe/jev-latest',
    })
  })

  it('reports a Jev model value that is not a bare name', () => {
    const identity = resolve({ engine: 'jev', overrideEngine: 'jev', overrideModel: 'a/b' })
    expect(identity.model).toBe('jev-latest')
    expect(identity.rejectedOverride).toBe('a/b')
  })

  it('reports a Jev switch that named no model at all', () => {
    // The engine switches, but there is no model for it; the runtime clamps the
    // empty model to `reviewer.jev.model` before dispatching.
    const identity = resolve({ engine: 'llm', overrideEngine: 'jev', jevPermitted: true })
    expect(identity).toEqual({ engine: 'jev', provider: 'typesafe', model: '', rejectedOverride: 'typesafe/' })
  })

  it('treats blank halves as absent', () => {
    expect(resolve({ engine: 'llm', overrideProvider: '  ', overrideModel: '' }))
      .toEqual({ engine: 'llm', provider: 'mtfriday', model: 'deepseek-v4-flash' })
  })
})
