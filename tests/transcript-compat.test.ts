import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { Config, type Config as ConfigShape } from '../src/config.ts'
import { applyAuditEvent, formatReviewMarker, initAuditState } from '../src/audit.ts'
import { blocksToText, ReviewRuntime } from '../src/runtime.ts'
import { toolResultCallId } from '../src/transcript-compat.ts'

function event(type: string, data: unknown): SessionEvent {
  return { type, data, seq: 0, time: 0 } as SessionEvent
}

const marker = formatReviewMarker({ reason: 'outside authorization', risk: 'high' })
const text = [{ type: 'text', text: marker }]
const results = [
  { role: 'tool', source: { kind: 'tool', callId: 'c' }, toolCallId: 'c', content: text },
  { role: 'user', source: { kind: 'tool', callId: 'c', toolName: 'bash' }, content: [{ type: 'tool-result', toolCallId: 'c', content: text }] },
  { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c', content: text }] },
]

describe('host transcript compatibility', () => {
  it.each(results)('recovers the audit rationale and tool evidence for $role results', message => {
    const events = [
      event('turn/start', { turn: 1 }),
      event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Only inspect files.' }] }),
      event('approval/asked', { id: 'a', callId: 'c', toolName: 'bash' }),
      event('approval/decided', { id: 'a', outcome: 'rejected' }),
      event('tool/result', { message }),
    ]
    const state = events.reduce((s, e) => applyAuditEvent(s, e, { enabledByDefault: true }), initAuditState())
    expect(state.records[0]).toMatchObject({ callId: 'c', outcome: 'rejected', refused: true, reason: 'outside authorization', risk: 'high' })
    const session = { seq: events.length, eventAt: (seq: number) => events[seq], header: {} } as unknown as Session
    const config = (Config as unknown as (value: unknown) => ConfigShape)({ context: { includeToolActivity: true } })
    const runtime = new ReviewRuntime({} as Context, config)
    expect(runtime.buildTranscript(session)).toContain('outside authorization')
    // Tool-result content never becomes direct-human authorization.
    expect(runtime.buildUserIntent(session)).toContain('Only inspect files.')
    expect(runtime.buildUserIntent(session)).not.toContain('outside authorization')
  })

  it('ignores non-text blocks and preserves nested legacy result text', () => {
    expect(blocksToText([
      { type: 'text', text: 'first' },
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'tool-result', content: [{ type: 'text', text: 'second' }, { type: 'image' }] },
    ])).toBe('first\nsecond')
  })

  it('does not correlate conflicting or non-tool metadata', () => {
    expect(toolResultCallId({ ...results[0]!, toolCallId: 'different' })).toBeUndefined()
    expect(toolResultCallId({ ...results[2]!, source: { kind: 'user' } })).toBeUndefined()
    expect(toolResultCallId({ ...results[0]!, source: { kind: 'tool', callId: '' } })).toBeUndefined()
    expect(toolResultCallId({ content: text })).toBeUndefined()
  })
})
