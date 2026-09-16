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
import { directoryRoutes, filterRoutes, reviewerRouteChoices, routesFromDirectory } from '../src/client/model-choices.ts'

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
