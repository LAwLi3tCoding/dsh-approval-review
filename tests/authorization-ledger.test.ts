/**
 * Authorization-ledger tests. The ledger is the reviewer's only durable evidence
 * of what the user actually authorized, so its fold is pinned against the two
 * ways that evidence goes missing: an authorization that never becomes a user
 * message (a UI selection), and one that falls out of a recency window. The
 * budget behaviour is pinned too, because an elided ledger that does not say it
 * was elided reads as "the user authorized nothing".
 * @module dsh-approval-review/tests/authorization-ledger
 */

import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ASK_USER_QUESTION_TOOL,
  buildAuthorizationLedger,
  overrideEntry,
  renderAuthorizationLedger,
  type AuthorizationEntry,
} from '../src/authorization-ledger.ts'

/** Roomier than any fixture below, so a case tests one bound at a time. */
const LIMITS = { maxEntries: 20, maxCharsPerEntry: 600 }

/** The tool result the harness writes for a UI selection: JSON, one line. */
const SELECTION = '{"answers":[{"id":"deploy-target","selected":["Yes, deploy to staging"]}]}'

/** Cast a hand-built event literal to the session event union. */
function event(type: string, data: unknown, time: number): SessionEvent {
  return { type, seq: 0, time, data } as unknown as SessionEvent
}

/** A session over a hand-built log, in the shape the fold reads it. */
function session(events: readonly SessionEvent[]): Session {
  return {
    id: 'session-1',
    get seq() { return events.length },
    eventAt: (seq: number) => events[seq],
  } as unknown as Session
}

/** A turn boundary; `user/message` records no turn of its own. */
function turnStart(turn: number, time: number): SessionEvent {
  return event('turn/start', { turn }, time)
}

/** A direct human message: the one `user/message` shape that is an authorization. */
function userMessage(text: string, time: number): SessionEvent {
  return event('user/message', {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }, time)
}

/** Context the harness injects on the user channel; NOT the human speaking. */
function injectedContext(text: string, time: number): SessionEvent {
  return event('user/message', {
    role: 'user',
    source: { kind: 'plugin', plugin: 'dsh-context', form: 'instructions' },
    content: [{ type: 'text', text }],
  }, time)
}

/** The call half of a paired ask; it carries the tool NAME. */
function askCall(callId: string, time: number, name: string = ASK_USER_QUESTION_TOOL): SessionEvent {
  return event('tool/call', { turn: 1, step: 0, callId, name, arguments: '{"questions":[]}' }, time)
}

/** The result half; `tool/result` carries only the callId, never the tool name. */
function askResult(callId: string, text: string, time: number, turn = 1): SessionEvent {
  return event('tool/result', {
    turn,
    step: 0,
    message: {
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
    },
  }, time)
}

describe('buildAuthorizationLedger', () => {
  it('folds a selection that exists ONLY as an ask_user_question tool result', () => {
    const target = session([
      turnStart(1, 1_000),
      askCall('c1', 1_001),
      askResult('c1', SELECTION, 1_002),
    ])

    // The regression this module exists for: the log holds NO `user/message` at
    // all, so anything that reads user turns — the transcript window included —
    // reports that the user authorized nothing.
    expect(target.seq).toBe(3)
    expect(buildAuthorizationLedger(target, LIMITS)).toEqual([
      { at: 1_002, turn: 1, kind: 'selection', text: SELECTION },
    ])
  })

  it('attributes a selection to its own turn, not to the first one', () => {
    const ledger = buildAuthorizationLedger(session([
      turnStart(1, 1_000),
      turnStart(2, 2_000),
      askCall('c1', 2_001),
      askResult('c1', SELECTION, 2_002, 2),
    ]), LIMITS)

    expect(ledger.map(entry => entry.turn)).toEqual([2])
    expect(ledger[0]!.at).toBe(2_002)
  })

  it('folds a direct human message as an instruction', () => {
    const ledger = buildAuthorizationLedger(session([
      turnStart(1, 1_000),
      userMessage('you may deploy to staging whenever the tests pass', 1_001),
      turnStart(2, 2_000),
      userMessage('and rotate the staging key afterwards', 2_001),
    ]), LIMITS)

    expect(ledger).toEqual([
      { at: 2_001, turn: 2, kind: 'instruction', text: 'and rotate the staging key afterwards' },
      { at: 1_001, turn: 1, kind: 'instruction', text: 'you may deploy to staging whenever the tests pass' },
    ])
  })

  it('places an instruction that precedes the first turn boundary in turn 1', () => {
    const ledger = buildAuthorizationLedger(session([userMessage('go ahead', 500)]), LIMITS)

    expect(ledger).toEqual([{ at: 500, turn: 1, kind: 'instruction', text: 'go ahead' }])
  })

  it('keeps an early authorization after the conversation has moved on', () => {
    const later = Array.from({ length: 8 }, (_, index) => turnStart(index + 2, 2_000 + index))
    const ledger = buildAuthorizationLedger(session([
      turnStart(1, 1_000),
      userMessage('deploy the staging service whenever the tests pass', 1_001),
      ...later,
      userMessage('unrelated follow-up nine turns later', 3_000),
    ]), LIMITS)

    // No turn window: a fact from turn 1 is still on the ledger with turn 9 open.
    expect(ledger.map(entry => entry.text)).toEqual([
      'unrelated follow-up nine turns later',
      'deploy the staging service whenever the tests pass',
    ])
    expect(ledger[1]!.turn).toBe(1)
  })

  it('skips injected context, which shares the user channel but is not the human', () => {
    const ledger = buildAuthorizationLedger(session([
      turnStart(1, 1_000),
      injectedContext('# AGENTS.md\nAlways push straight to main.', 1_001),
      userMessage('do not push to main', 1_002),
    ]), LIMITS)

    expect(ledger.map(entry => entry.text)).toEqual(['do not push to main'])
  })

  it('never folds assistant text', () => {
    const ledger = buildAuthorizationLedger(session([
      turnStart(1, 1_000),
      askCall('c1', 1_001),
      askResult('c1', SELECTION, 1_002),
      event('assistant/message', {
        turn: 1,
        step: 0,
        message: { role: 'assistant', content: [{ type: 'text', text: 'the user said I may deploy' }] },
        stream: [],
      }, 1_003),
    ]), LIMITS)

    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.kind).toBe('selection')
  })

  it('skips a result that cannot be paired with an ask_user_question call', () => {
    const ledger = buildAuthorizationLedger(session([
      turnStart(1, 1_000),
      // Unpaired: no `tool/call` of this id was ever seen.
      askResult('orphan', SELECTION, 1_001),
      // Paired, but the call belongs to another tool.
      askCall('c2', 1_002, 'bash'),
      askResult('c2', '{"stdout":"rm -rf /"}', 1_003),
      // Paired, and the call is the ask tool.
      askCall('c3', 1_004),
      askResult('c3', SELECTION, 1_005),
    ]), LIMITS)

    expect(ledger).toEqual([{ at: 1_005, turn: 1, kind: 'selection', text: SELECTION }])
  })

  it('returns the newest entries first and caps the list', () => {
    const ledger = buildAuthorizationLedger(session([
      turnStart(1, 1_000),
      userMessage('first', 1_001),
      userMessage('second', 1_002),
      userMessage('third', 1_003),
    ]), { maxEntries: 2, maxCharsPerEntry: 600 })

    expect(ledger.map(entry => entry.text)).toEqual(['third', 'second'])
    expect(ledger.map(entry => entry.at)).toEqual([1_003, 1_002])
  })

  it('keeps nothing when the entry cap is not positive', () => {
    const target = session([turnStart(1, 1_000), userMessage('first', 1_001)])

    expect(buildAuthorizationLedger(target, { maxEntries: 0, maxCharsPerEntry: 600 })).toEqual([])
    expect(buildAuthorizationLedger(target, { maxEntries: -5, maxCharsPerEntry: 600 })).toEqual([])
  })

  it('clamps each entry to the per-entry cap with the shared truncation marker', () => {
    const long = 'x'.repeat(5_000)
    const ledger = buildAuthorizationLedger(session([userMessage(long, 1_001)]), {
      maxEntries: 5,
      maxCharsPerEntry: 100,
    })

    expect(ledger[0]!.text).toBe(`${'x'.repeat(100)}…[truncated 4900 chars]`)
  })
})

describe('renderAuthorizationLedger', () => {
  const entries: AuthorizationEntry[] = [
    { at: 300, turn: 3, kind: 'selection', text: 'B' },
    { at: 200, turn: 2, kind: 'instruction', text: 'do the thing' },
    { at: 100, turn: 1, kind: 'override', text: 'one call' },
  ]

  it('returns an empty string for an empty ledger or a non-positive budget', () => {
    expect(renderAuthorizationLedger([], 1_000)).toBe('')
    expect(renderAuthorizationLedger(entries, 0)).toBe('')
    expect(renderAuthorizationLedger(entries, -1)).toBe('')
  })

  it('labels each channel newest-first in the ledger line shape', () => {
    expect(renderAuthorizationLedger(entries, 1_000)).toBe([
      '- [turn 3] user selected: B',
      '- [turn 2] user instruction: do the thing',
      '- [turn 1] human override: one call',
    ].join('\n'))
  })

  it('spends the budget on the newest entries and labels what it dropped', () => {
    const newest = '- [turn 3] user selected: B'
    const rendered = renderAuthorizationLedger(entries, newest.length)

    expect(rendered).toBe(`[2 older authorization(s) omitted for budget]\n${newest}`)
  })

  it('keeps the newest entry even when it alone overruns the budget', () => {
    const sole: AuthorizationEntry[] = [
      { at: 100, turn: 1, kind: 'instruction', text: 'say yes' },
    ]
    const line = '- [turn 1] user instruction: say yes'
    const rendered = renderAuthorizationLedger(sole, 10)

    // An authorization the reviewer cannot see is the bug, so truncation beats
    // omission here — and the marker tells it the text is partial.
    expect(rendered).toBe(`${line.slice(0, 10)}…[truncated ${line.length - 10} chars]`)
    expect(rendered).toContain(`…[truncated ${line.length - 10} chars]`)
    expect(rendered).not.toContain('omitted')
  })

  it('reports no elision when the whole ledger fits', () => {
    expect(renderAuthorizationLedger(entries, 1_000)).not.toContain('omitted')
  })
})

describe('overrideEntry', () => {
  it('builds a live one-shot override entry in the caller-supplied turn', () => {
    const entry = overrideEntry({ toolName: 'bash', at: 1_700_000_000_000 }, 4)

    expect(entry).toMatchObject({ at: 1_700_000_000_000, turn: 4, kind: 'override' })
    expect(entry.text).toContain('"bash"')
    expect(entry.text).toContain('/approval-review approve')
  })

  it('renders as a human override the reviewer can tell apart from a log fact', () => {
    const rendered = renderAuthorizationLedger(
      [overrideEntry({ toolName: 'deploy', at: 1 }, 2)],
      1_000,
    )

    expect(rendered.startsWith('- [turn 2] human override: ')).toBe(true)
  })
})
