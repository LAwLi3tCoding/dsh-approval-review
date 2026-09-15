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

  it('counts an approve command as a pending override', () => {
    const state = fold([event('command/run', { commandId: 'x', name: COMMAND_NAME, args: 'approve 1', source: 'user' })])
    expect(state.pendingOverrides).toBe(1)
  })

  it('consumes a pending override on the next recorded approval', () => {
    const state = fold([
      event('command/run', { commandId: 'x', name: COMMAND_NAME, args: 'approve 1', source: 'user' }),
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'a', toolName: 'bash' }),
    ])
    expect(state.pendingOverrides).toBe(0)
    expect(state.records[0]!.overridden).toBe(true)
  })

  it('ignores another plugin\u2019s command', () => {
    const state = initAuditState()
    expect(applyAuditEvent(state, event('command/run', { commandId: 'x', name: 'other', args: 'off', source: 'user' }), DEFAULTS))
      .toBe(state)
  })
})

describe('auditView', () => {
  it('applies the deployment switch default when the log carries no override', () => {
    const view = auditView(initAuditState(), { enabledByDefault: false, maxReviewsPerTurn: 7, breakerTrips: false })
    expect(view.enabled).toBe(false)
    expect(view.maxReviewsPerTurn).toBe(7)
  })

  it('prefers the logged override over the default', () => {
    const state = fold([event('command/run', { commandId: 'x', name: COMMAND_NAME, args: 'off', source: 'user' })])
    const view = auditView(state, { enabledByDefault: true, maxReviewsPerTurn: 7, breakerTrips: false })
    expect(view.enabled).toBe(false)
  })

  it('reports the breaker and counters', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'a', toolName: 'bash' }),
      event('approval/decided', { id: 'a', outcome: 'rejected' }),
    ])
    const view = auditView(state, { enabledByDefault: true, maxReviewsPerTurn: 7, breakerTrips: true })
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
