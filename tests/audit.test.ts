/**
 * Audit-ledger tests. The ledger is the card's only data source, so its fold and
 * its marker round-trip are pinned here — including the guarantee that the plugin
 * never needs a custom session event type to record a decision.
 * @module dsh-approval-review/tests/audit
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  COMMAND_NAME,
  MAX_RECORDS,
  REVIEW_MARKER,
  applyAuditEvent,
  auditView,
  formatReviewMarker,
  initAuditState,
  parseReviewMarker,
  type AuditState,
} from '../src/audit.ts'

/** Cast a hand-built event literal to the session event union. */
function event<T extends string>(type: T, data: unknown): SessionEvent {
  return { type, seq: 0, time: 0, data } as unknown as SessionEvent
}

const DEFAULTS = { enabledByDefault: true }

/** Fold a list of events over the empty ledger. */
function fold(events: readonly SessionEvent[], start: AuditState = initAuditState()): AuditState {
  return events.reduce((state, next) => applyAuditEvent(state, next, DEFAULTS), start)
}

/** Build the event sequence for one reviewed-and-refused tool call. */
function refusalSequence(overrides: { callId?: string; outcome?: string } = {}): SessionEvent[] {
  const callId = overrides.callId ?? 'call-1'
  return [
    event('turn/start', { turn: 1 }),
    event('step/start', { turn: 1, step: 0 }),
    event('tool/call', { turn: 1, step: 0, callId, name: 'bash', arguments: '{"command":"rm -rf /"}' }),
    event('approval/asked', { id: 'appr-1', toolName: 'bash', callId, reason: 'needs escalation' }),
    event('approval/decided', { id: 'appr-1', outcome: overrides.outcome ?? 'rejected' }),
    event('tool/result', {
      turn: 1,
      step: 0,
      message: {
        role: 'user',
        source: { kind: 'tool', toolName: 'bash', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{
            type: 'text',
            text: `Error: refused\n${formatReviewMarker({
              reason: 'would delete the workspace root',
              risk: 'critical',
              suggestion: 'scope the delete to the build directory',
              reviewerRoute: 'p/m',
              durationMs: 1234,
            })}`,
          }],
        }],
      },
    }),
  ]
}

describe('initAuditState', () => {
  it('starts empty with the sequence at one', () => {
    const state = initAuditState()
    expect(state.records).toEqual([])
    expect(state.total).toBe(0)
    expect(state.nextSeq).toBe(1)
  })
})

describe('applyAuditEvent', () => {
  it('preserves the recorded timestamp across history replay', () => {
    const asked = { ...event('approval/asked', { id: 'a', toolName: 'bash' }), time: 1720000000000 }
    expect(fold([asked]).records[0]!.startedAt).toBe(asked.time)
    expect(fold([asked]).records[0]!.startedAt).toBe(asked.time)
  })

  it('returns the same reference for an uninteresting event', () => {
    const state = initAuditState()
    expect(applyAuditEvent(state, event('step/end', { turn: 1, step: 0 }), DEFAULTS)).toBe(state)
  })

  it('records an approval as pending, then settles it on the decision', () => {
    const pending = fold([
      event('turn/start', { turn: 1 }),
      event('step/start', { turn: 1, step: 0 }),
      event('tool/call', { turn: 1, step: 0, callId: 'c', name: 'bash', arguments: '{"command":"ls"}' }),
      event('approval/asked', { id: 'a', toolName: 'bash', callId: 'c', reason: 'why' }),
    ])
    expect(pending.records).toHaveLength(1)
    expect(pending.records[0]!.outcome).toBeUndefined()
    expect(pending.records[0]!.argumentsPreview).toBe('{"command":"ls"}')
    expect(pending.records[0]!.askReason).toBe('why')
    expect(pending.total).toBe(1)

    const settled = applyAuditEvent(pending, event('approval/decided', { id: 'a', outcome: 'allowed-once' }), DEFAULTS)
    expect(settled.records[0]!.outcome).toBe('allowed-once')
    expect(settled.records[0]!.refused).toBe(false)
    expect(settled.denialsStreak).toBe(0)
  })

  it('counts a refusal into the streak and window', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'a', toolName: 'bash' }),
      event('approval/decided', { id: 'a', outcome: 'rejected' }),
    ])
    expect(state.refused).toBe(1)
    expect(state.denialsStreak).toBe(1)
    expect(state.window).toEqual([true])
  })

  it('resets the denial streak on any grant', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'a', toolName: 'bash' }),
      event('approval/decided', { id: 'a', outcome: 'rejected' }),
      event('approval/asked', { id: 'b', toolName: 'bash' }),
      event('approval/decided', { id: 'b', outcome: 'allowed-once' }),
    ])
    expect(state.denialsStreak).toBe(0)
    expect(state.refused).toBe(1)
    expect(state.total).toBe(2)
  })

  it('treats cancelled and unavailable as refusals', () => {
    for (const outcome of ['cancelled', 'unavailable']) {
      const state = fold([
        event('turn/start', { turn: 1 }),
        event('approval/asked', { id: 'a', toolName: 'bash' }),
        event('approval/decided', { id: 'a', outcome }),
      ])
      expect(state.denialsStreak, outcome).toBe(1)
    }
  })

  it('resets the per-turn counters at a new turn', () => {
    const before = fold([
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'a', toolName: 'bash' }),
      event('approval/decided', { id: 'a', outcome: 'rejected' }),
    ])
    const after = applyAuditEvent(before, event('turn/start', { turn: 2 }), DEFAULTS)
    expect(after.denialsStreak).toBe(0)
    expect(after.window).toEqual([])
    expect(after.reviewsThisTurn).toBe(0)
  })

  it('ignores a decision without a matching ask', () => {
    const state = initAuditState()
    expect(applyAuditEvent(state, event('approval/decided', { id: 'ghost', outcome: 'rejected' }), DEFAULTS)).toBe(state)
  })

  it('folds the refusal marker onto the matching record by callId', () => {
    const state = fold(refusalSequence())
    const record = state.records[0]!
    expect(record.reason).toBe('would delete the workspace root')
    expect(record.risk).toBe('critical')
    expect(record.suggestion).toBe('scope the delete to the build directory')
    expect(record.reviewerRoute).toBe('p/m')
    expect(record.durationMs).toBe(1234)
    expect(record.uncertain).toBe(false)
  })

  it('leaves a record with no marker without a rationale', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'a', toolName: 'bash', callId: 'c' }),
      event('approval/decided', { id: 'a', outcome: 'rejected' }),
    ])
    expect(state.records[0]!.reason).toBeUndefined()
  })

  it('does not re-fold a marker onto a record that already has a rationale', () => {
    const once = fold(refusalSequence())
    const resultEvent = refusalSequence().at(-1)!
    const twice = applyAuditEvent(once, resultEvent, DEFAULTS)
    expect(twice.records).toHaveLength(1)
    expect(twice.records[0]!.reason).toBe('would delete the workspace root')
  })

  it('ignores a marker whose callId matches no record', () => {
    const state = fold(refusalSequence())
    const orphan = refusalSequence({ callId: 'other-call' }).at(-1)!
    expect(applyAuditEvent(state, orphan, DEFAULTS)).toBe(state)
  })

  it('folds an ALLOW marker onto an allowed record', () => {
    // The allow verdict rides the accepted tool result exactly like a refusal,
    // which is what gives an allowed row a rationale in the card.
    const state = fold([
      event('turn/start', { turn: 1 }),
      event('tool/call', { turn: 1, step: 0, callId: 'c', name: 'bash', arguments: '{"command":"ls"}' }),
      event('approval/asked', { id: 'a', toolName: 'bash', callId: 'c' }),
      event('approval/decided', { id: 'a', outcome: 'allowed-once' }),
      event('tool/result', {
        turn: 1,
        step: 0,
        message: {
          role: 'user',
          source: { kind: 'tool', toolName: 'bash', callId: 'c' },
          content: [{
            type: 'tool-result',
            toolCallId: 'c',
            content: [{
              type: 'text',
              text: `listing\n${formatReviewMarker({ reason: 'read-only listing', risk: 'low' })}`,
            }],
          }],
        },
      }),
    ])
    expect(state.records[0]!.refused).toBe(false)
    expect(state.records[0]!.reason).toBe('read-only listing')
    expect(state.records[0]!.risk).toBe('low')
  })

  it('stamps the row with the policy that actually routed it', () => {
    const resolvePolicy = (toolName: string): { policy: 'ai' | 'human'; source: string } =>
      toolName === 'bash' ? { policy: 'ai', source: 'reviewTools ("bash")' } : { policy: 'human', source: 'defaultPolicy' }
    const state = [
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'a', toolName: 'bash' }),
      event('approval/asked', { id: 'b', toolName: 'web_fetch' }),
    ].reduce((acc, next) => applyAuditEvent(acc, next, { ...DEFAULTS, resolvePolicy }), initAuditState())
    // Newest first: `web_fetch` was asked last, so it heads the ledger.
    expect(state.records[0]!).toMatchObject({ toolName: 'web_fetch', policy: 'human', policySource: 'defaultPolicy' })
    expect(state.records[1]!).toMatchObject({ toolName: 'bash', policy: 'ai', policySource: 'reviewTools ("bash")' })
  })

  it('falls back to the historical ai/unrecorded stamp without a resolver', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'a', toolName: 'bash' }),
    ])
    expect(state.records[0]!).toMatchObject({ policy: 'ai', policySource: 'unrecorded' })
  })

  it('caps the retained records at the newest MAX_RECORDS', () => {
    const events: SessionEvent[] = [event('turn/start', { turn: 1 })]
    for (let index = 0; index < MAX_RECORDS + 20; index += 1) {
      events.push(event('approval/asked', { id: `a${index}`, toolName: 'bash' }))
    }
    const state = fold(events)
    expect(state.records).toHaveLength(MAX_RECORDS)
    // Newest first: the last ask is at the head.
    expect(state.records[0]!.reviewId).toBe(`a${MAX_RECORDS + 19}`)
  })

  it('bounds a long arguments preview', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      event('tool/call', { turn: 1, step: 0, callId: 'c', name: 'bash', arguments: 'x'.repeat(5000) }),
      event('approval/asked', { id: 'a', toolName: 'bash', callId: 'c' }),
    ])
    expect(state.records[0]!.argumentsPreview!.length).toBeLessThan(1300)
  })

  it('folds the durable switch from the command event', () => {
    const off = fold([event('command/run', { commandId: 'x', name: COMMAND_NAME, args: 'off', source: 'user' })])
    expect(off.enabledOverride).toBe(false)
    const on = applyAuditEvent(off, event('command/run', { commandId: 'y', name: COMMAND_NAME, args: 'on', source: 'user' }), DEFAULTS)
    expect(on.enabledOverride).toBe(true)
  })

  it('tolerates case and extra whitespace in the switch command', () => {
    const state = fold([event('command/run', { commandId: 'x', name: COMMAND_NAME, args: 'OFF', source: 'user' })])
    expect(state.enabledOverride).toBe(false)
  })

  it('does not restore ephemeral authorizations from historical commands', () => {
    const state = fold([event('command/run', { commandId: 'x', name: COMMAND_NAME, args: 'approve 1', source: 'user' })])
    expect(state.pendingOverrides).toBe(0)
  })

  it('does not label an unrelated later request as human-authorized', () => {
    const state = fold([
      event('command/run', { commandId: 'x', name: COMMAND_NAME, args: 'approve 1', source: 'user' }),
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'a', toolName: 'bash' }),
    ])
    expect(state.pendingOverrides).toBe(0)
    expect(state.records[0]!.overridden).toBe(false)
  })

  it('ignores another plugin\u2019s command', () => {
    const state = initAuditState()
    expect(applyAuditEvent(state, event('command/run', { commandId: 'x', name: 'other', args: 'off', source: 'user' }), DEFAULTS))
      .toBe(state)
  })
})

describe('auditView', () => {
  it('reports the reviewer a session selection switched to', () => {
    const defaults = {
      enabledByDefault: true, maxReviewsPerTurn: 10, breakerTrips: false,
      defaultReviewerProvider: 'typesafe', defaultReviewerModel: 'jev-latest', defaultReviewerEngine: 'jev' as const,
      defaultJevPermitted: true,
    }
    // The deployment's own reviewer until a session selects another one.
    expect(auditView(initAuditState(), defaults)).toMatchObject({ reviewerEngine: 'jev', reviewerModel: 'jev-latest' })
    const after = (args: string): ReturnType<typeof auditView> => auditView(
      fold([event('command/run', { commandId: 'm', name: COMMAND_NAME, args, source: 'user' })]),
      defaults,
    )
    // A Jev row keeps the Jev engine and pins the version.
    expect(after('model typesafe/jev-1.13.0')).toMatchObject({ reviewerEngine: 'jev', reviewerModel: 'jev-1.13.0' })
    // An LLM row switches the session to that route: the picker lists it, so
    // choosing it has to mean something.
    expect(after('model mtfriday/deepseek-v4-flash'))
      .toMatchObject({ reviewerEngine: 'llm', reviewerProvider: 'mtfriday', reviewerModel: 'deepseek-v4-flash' })
    // `default` returns to the deployment's own reviewer.
    expect(after('model default')).toMatchObject({ reviewerEngine: 'jev', reviewerModel: 'jev-latest' })
  })

  it('applies the deployment switch default when the log carries no override', () => {
    const view = auditView(initAuditState(), { enabledByDefault: false, maxReviewsPerTurn: 7, breakerTrips: false, defaultReviewerProvider: '', defaultReviewerEngine: 'llm', defaultJevPermitted: false, defaultReviewerModel: '' })
    expect(view.enabled).toBe(false)
    expect(view.maxReviewsPerTurn).toBe(7)
  })

  it('prefers the logged override over the default', () => {
    const state = fold([event('command/run', { commandId: 'x', name: COMMAND_NAME, args: 'off', source: 'user' })])
    const view = auditView(state, { enabledByDefault: true, maxReviewsPerTurn: 7, breakerTrips: false, defaultReviewerProvider: '', defaultReviewerEngine: 'llm', defaultJevPermitted: false, defaultReviewerModel: '' })
    expect(view.enabled).toBe(false)
  })

  it('reports the breaker and counters', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'a', toolName: 'bash' }),
      event('approval/decided', { id: 'a', outcome: 'rejected' }),
    ])
    const view = auditView(state, { enabledByDefault: true, maxReviewsPerTurn: 7, breakerTrips: true, defaultReviewerProvider: '', defaultReviewerEngine: 'llm', defaultJevPermitted: false, defaultReviewerModel: '' })
    expect(view.refused).toBe(1)
    expect(view.total).toBe(1)
    expect(view.consecutiveDenials).toBe(1)
    expect(view.circuitOpen).toBe(true)
  })
})

describe('review marker round-trip', () => {
  it('recovers every field it writes', () => {
    const marker = formatReviewMarker({
      reason: 'sends data to an unknown host',
      risk: 'high',
      suggestion: 'use the approved mirror',
      reviewerRoute: 'provider/model',
      durationMs: 42,
      uncertain: true,
    })
    const parsed = parseReviewMarker(marker)
    expect(parsed).toEqual({
      reason: 'sends data to an unknown host',
      risk: 'high',
      suggestion: 'use the approved mirror',
      reviewerRoute: 'provider/model',
      durationMs: 42,
      uncertain: true,
    })
  })

  it('recovers a minimal marker', () => {
    const parsed = parseReviewMarker(formatReviewMarker({ reason: 'no' }))
    expect(parsed?.reason).toBe('no')
    expect(parsed?.uncertain).toBe(false)
    expect(parsed?.risk).toBeUndefined()
  })

  it('finds the marker inside surrounding error text', () => {
    const text = `Error: something\n${formatReviewMarker({ reason: 'blocked' })}\nmore text`
    expect(parseReviewMarker(text)?.reason).toBe('blocked')
  })

  it('drops an unrecognized risk value instead of trusting it', () => {
    expect(parseReviewMarker(`${REVIEW_MARKER}\nreason: x\nrisk: extreme`)?.risk).toBeUndefined()
  })

  it('returns undefined for text without the marker', () => {
    expect(parseReviewMarker('Error: plain failure')).toBeUndefined()
  })

  it('returns undefined when the marker carries no reason', () => {
    expect(parseReviewMarker(`${REVIEW_MARKER}\nrisk: low`)).toBeUndefined()
  })

  it('collapses a multi-line reason into one recovered line', () => {
    // The writer must not emit a newline inside a field, or the parser would read
    // the continuation as a forged field boundary.
    const marker = formatReviewMarker({ reason: 'line one\nline two' })
    expect(marker).not.toContain('line one\nline two')
    expect(parseReviewMarker(marker)?.reason).toBe('line one line two')
  })
})

describe('reviewer-model override', () => {
  const withModel = (args: string) =>
    fold([event('command/run', { commandId: 'x', name: COMMAND_NAME, args, source: 'user' })])
  const command = (name: string, args: string) =>
    event('command/run', { commandId: 'y', name, args, source: 'user' })

  it('records a durable model override from the command', () => {
    const state = withModel('model deepseek-chat')
    expect(state.modelOverride).toBe('deepseek-chat')
    const view = auditView(state, { enabledByDefault: true, maxReviewsPerTurn: 10, breakerTrips: false, defaultReviewerProvider: '', defaultReviewerEngine: 'llm', defaultJevPermitted: false, defaultReviewerModel: 'default-model' })
    expect(view.reviewerModel).toBe('deepseek-chat')
  })

  it('records a provider alongside the model when the command names both', () => {
    const state = withModel('model openai-codex/gpt-5.6-luna')
    expect(state.modelOverride).toBe('gpt-5.6-luna')
    expect(state.providerOverride).toBe('openai-codex')
    const view = auditView(state, { enabledByDefault: true, maxReviewsPerTurn: 10, breakerTrips: false, defaultReviewerProvider: '', defaultReviewerEngine: 'llm', defaultJevPermitted: false, defaultReviewerModel: '' })
    expect(view.reviewerProvider).toBe('openai-codex')
    expect(view.reviewerModel).toBe('gpt-5.6-luna')
  })

  it('drops a stale provider when the command names only a model', () => {
    // The two halves travel together: keeping the old provider is how a session
    // ends up asking the wrong vendor for a model id.
    const withProvider = withModel('model openai-codex/gpt-5.6-luna')
    const state = applyAuditEvent(withProvider, command('approval-review', 'model deepseek-chat'), DEFAULTS)
    expect(state.providerOverride).toBeUndefined()
    expect(state.modelOverride).toBe('deepseek-chat')
  })

  it('clears both halves with `model default`', () => {
    const both = withModel('model openai-codex/gpt-5.6-luna')
    const state = applyAuditEvent(both, command('approval-review', 'model default'), DEFAULTS)
    expect(state.providerOverride).toBeUndefined()
    expect(state.modelOverride).toBeUndefined()
  })

  it('falls back to the deployment default without an override', () => {
    const view = auditView(initAuditState(), { enabledByDefault: true, maxReviewsPerTurn: 10, breakerTrips: false, defaultReviewerProvider: '', defaultReviewerEngine: 'llm', defaultJevPermitted: false, defaultReviewerModel: 'default-model' })
    expect(view.reviewerModel).toBe('default-model')
  })

  it('reports an empty string when nothing is configured', () => {
    const view = auditView(initAuditState(), { enabledByDefault: true, maxReviewsPerTurn: 10, breakerTrips: false, defaultReviewerProvider: '', defaultReviewerEngine: 'llm', defaultJevPermitted: false, defaultReviewerModel: '' })
    expect(view.reviewerModel).toBe('')
  })

  it('clears the override with `model default` and drops the key', () => {
    const set = withModel('model some-model')
    const cleared = applyAuditEvent(set, event('command/run', { commandId: 'y', name: COMMAND_NAME, args: 'model default', source: 'user' }), DEFAULTS)
    expect(cleared.modelOverride).toBeUndefined()
    expect(Object.hasOwn(cleared, 'modelOverride')).toBe(false)
  })

  it('keeps the whole id when it has spaces and no provider half', () => {
    const state = withModel('model my model v2')
    expect(state.modelOverride).toBe('my model v2')
    expect(state.providerOverride).toBeUndefined()
  })

  it('splits a single provider slash, and only that one', () => {
    const split = withModel('model vendor/some model')
    expect(split.providerOverride).toBe('vendor')
    expect(split.modelOverride).toBe('some model')
    // Two slashes is a model id, not a provider pair.
    const unsplit = withModel('model org/family/model')
    expect(unsplit.providerOverride).toBeUndefined()
    expect(unsplit.modelOverride).toBe('org/family/model')
  })

  it('leaves the override alone for an unrelated command', () => {
    const set = withModel('model m1')
    const other = applyAuditEvent(set, event('command/run', { commandId: 'y', name: COMMAND_NAME, args: 'status', source: 'user' }), DEFAULTS)
    expect(other.modelOverride).toBe('m1')
  })
})

describe('authorization assessment audit', () => {
  it('round-trips authorization separately from risk', () => {
    const marker = formatReviewMarker({ reason: 'User requested this bounded operation', risk: 'high', userAuthorization: 'medium' })
    expect(parseReviewMarker(marker)).toMatchObject({ risk: 'high', userAuthorization: 'medium' })
  })
})


it('records an exact-action approval only when carried by its review marker', () => {
  const parsed = parseReviewMarker(formatReviewMarker({ reason: 'exact retry', overridden: true }))
  expect(parsed?.overridden).toBe(true)
})
