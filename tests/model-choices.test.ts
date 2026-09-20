/**
 * Reviewer-route picker tests.
 *
 * The picker is fed by projections this plugin does not own, so the rule under
 * test is really "read them defensively": an unpublished projection, a missing
 * `lastUsed`, or an entry with one non-string half must contribute nothing
 * instead of putting a malformed route on the wire.
 * @module dsh-approval-review/tests/model-choices
 */

import { describe, expect, it } from 'vitest'
import {
  directoryRoutes,
  filterRoutes,
  JEV_MODEL_CHOICES,
  reviewerModelChoices,
  reviewerRouteChoices,
  routesFromDirectory,
} from '../src/client/model-choices.ts'

describe('reviewerRouteChoices', () => {
  it('lists the override in force first, then the session model, then allowed routes', () => {
    expect(reviewerRouteChoices({
      current: 'openai-codex/gpt-5.6-luna',
      sessionDefault: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      allowed: [
        { provider: 'deepseek-official', model: 'deepseek-flash' },
        { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      ],
    })).toEqual([
      'openai-codex/gpt-5.6-luna',
      'deepseek-official/deepseek-flash',
      'deepseek-official/deepseek-v4-pro',
    ])
  })

  it('deduplicates a model that is both the session default and an allowed route', () => {
    const choices = reviewerRouteChoices({
      sessionDefault: { lastUsed: { provider: 'p', model: 'm' } },
      allowed: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }],
    })
    expect(choices).toEqual(['p/m'])
  })

  it('drops malformed entries instead of surfacing half a route', () => {
    expect(reviewerRouteChoices({
      allowed: [
        { provider: 'p', model: 'm' },
        { provider: 'p' },
        { model: 'm' },
        { provider: '', model: 'm' },
        { provider: 'p', model: '' },
        null,
        'p/m',
        42,
      ],
    })).toEqual(['p/m'])
  })

  it('returns nothing for projections this host does not publish', () => {
    expect(reviewerRouteChoices({})).toEqual([])
    expect(reviewerRouteChoices({ allowed: undefined, sessionDefault: null })).toEqual([])
    expect(reviewerRouteChoices({ allowed: { provider: 'p', model: 'm' } })).toEqual([])
    expect(reviewerRouteChoices({ sessionDefault: { lastUsed: null } })).toEqual([])
  })

  it('keeps a cross-provider override visible even though it is not in the list', () => {
    const choices = reviewerRouteChoices({
      current: 'openai-codex/gpt-5.6-terra',
      allowed: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
    })
    expect(choices[0]).toBe('openai-codex/gpt-5.6-terra')
    expect(choices).toContain('deepseek-official/deepseek-flash')
  })
})

describe('routesFromDirectory', () => {
  it('flattens the client model catalog into provider/model routes', () => {
    expect(routesFromDirectory({
      groups: [
        { id: 'deepseek-official', models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] },
        { id: 'openai-codex', models: [{ id: 'gpt-5.6-luna' }] },
      ],
    })).toEqual([
      'deepseek-official/deepseek-flash',
      'deepseek-official/deepseek-v4-pro',
      'openai-codex/gpt-5.6-luna',
    ])
  })

  it('ignores failed or malformed groups instead of guessing', () => {
    expect(routesFromDirectory({
      groups: [
        { id: 'p', models: [{ id: 'm' }, { id: '' }, {}, null] },
        { id: '', models: [{ id: 'm' }] },
        { models: [{ id: 'm' }] },
        null,
      ],
      failures: [{ provider: 'broken', error: 'catalog failed' }],
    })).toEqual(['p/m'])
  })

  it('returns nothing for an unloaded or absent directory', () => {
    expect(routesFromDirectory(undefined)).toEqual([])
    expect(routesFromDirectory(null)).toEqual([])
    expect(routesFromDirectory({ status: 'loading', groups: [] })).toEqual([])
    expect(routesFromDirectory({})).toEqual([])
  })
})

describe('filterRoutes', () => {
  const ROUTES = ['deepseek-official/deepseek-flash', 'openai-codex/gpt-5.6-luna']

  it('keeps everything for an empty query', () => {
    expect(filterRoutes(ROUTES, '')).toEqual(ROUTES)
    expect(filterRoutes(ROUTES, '   ')).toEqual(ROUTES)
  })

  it('matches case-insensitively across provider and model', () => {
    expect(filterRoutes(ROUTES, 'LUNA')).toEqual(['openai-codex/gpt-5.6-luna'])
    expect(filterRoutes(ROUTES, 'codex/')).toEqual(['openai-codex/gpt-5.6-luna'])
    expect(filterRoutes(ROUTES, 'deepseek')).toEqual(['deepseek-official/deepseek-flash'])
  })

  it('returns nothing when nothing matches, so the picker can say so', () => {
    expect(filterRoutes(ROUTES, 'nope')).toEqual([])
  })
})

describe('directoryRoutes', () => {
  it('pairs each route id with the catalog display name', () => {
    const { routes, labels } = directoryRoutes({
      groups: [{
        id: 'deepseek-official',
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
          // A name identical to the id says nothing, so it is not a label.
          { id: 'same', name: 'same' },
          { id: 'nameless' },
        ],
      }],
    })
    expect(routes).toEqual([
      'deepseek-official/deepseek-flash',
      'deepseek-official/deepseek-v4-pro',
      'deepseek-official/same',
      'deepseek-official/nameless',
    ])
    expect(labels['deepseek-official/deepseek-flash']).toBe('DeepSeek-V41-Flash')
    expect(labels['deepseek-official/same']).toBeUndefined()
    expect(labels['deepseek-official/nameless']).toBeUndefined()
  })

  it('degrades to an empty pair for an unloaded directory', () => {
    expect(directoryRoutes(undefined)).toEqual({ routes: [], labels: {} })
    expect(directoryRoutes({ status: 'loading' })).toEqual({ routes: [], labels: {} })
  })
})

describe('reviewerModelChoices', () => {
  const llmRoutes = ['mtfriday/deepseek-v4-flash', 'deepseek-official/deepseek-flash']

  it('offers only LLM routes when the deployment never permitted Jev', () => {
    // Egress consent is the deployment's, so a session cannot be offered a row
    // that would switch to an engine the deployment has not acknowledged.
    expect(reviewerModelChoices(false, llmRoutes)).toEqual(llmRoutes)
  })

  it('offers the Jev models first when the deployment permits them', () => {
    const choices = reviewerModelChoices(true, llmRoutes)
    expect(choices.slice(0, JEV_MODEL_CHOICES.length)).toEqual(JEV_MODEL_CHOICES)
  })

  it('qualifies every Jev row with its engine marker', () => {
    // A bare model name only replaces a model on the engine already in force,
    // which is how a listed row could be chosen and then visibly do nothing.
    for (const row of JEV_MODEL_CHOICES) expect(row.startsWith('typesafe/')).toBe(true)
  })

  it('keeps every LLM route reachable alongside them', () => {
    const choices = reviewerModelChoices(true, llmRoutes)
    for (const route of llmRoutes) expect(choices).toContain(route)
  })

  it('de-duplicates a route that appears in the card and in the catalog', () => {
    const choices = reviewerModelChoices(true, ['typesafe/jev-latest', ...llmRoutes])
    expect(choices.filter(entry => entry === 'typesafe/jev-latest')).toHaveLength(1)
  })

  it('works when the deployment publishes no LLM catalog at all', () => {
    expect(reviewerModelChoices(true, [])).toEqual(JEV_MODEL_CHOICES)
  })
})
