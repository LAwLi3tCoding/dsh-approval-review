/**
 * Browser-half command dispatch tests.
 *
 * The bug these pin: the call was made with two arguments against a remote that
 * takes three, so EVERY control in the tab was a silent no-op. The fakes below
 * fail the same way the real facade does when the arity is wrong.
 * @module dsh-approval-review/tests/run-command
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { runCommandLine, type CommandRemoteFace } from '../src/client/run-command.ts'

const SESSION = 'session-1' as SessionId

/** A remote that records its call and answers with a scripted outcome. */
function remoteReturning(
  outcome: Awaited<ReturnType<CommandRemoteFace['commands']['execute']>>,
  calls: unknown[][] = [],
): CommandRemoteFace['commands'] {
  return {
    execute: async (...args: unknown[]) => {
      calls.push(args)
      // Mirror the facade's own guard: it rejects a call with the wrong arity.
      if (args.length < 3) {
        throw new Error(`client api: commands/execute expected 3 business argument(s) plus an optional AbortSignal, got ${String(args.length)}`)
      }
      return outcome
    },
  } as unknown as CommandRemoteFace['commands']
}

describe('runCommandLine', () => {
  it('sends the line with the attachments argument the remote requires', async () => {
    const calls: unknown[][] = []
    const remote = remoteReturning({ ok: true, value: { result: { kind: 'success', text: 'ok' } } }, calls)
    expect(await runCommandLine(remote, SESSION, '/approval-review status')).toBeNull()
    expect(calls).toEqual([[SESSION, '/approval-review status', []]])
  })

  it('returns the handler text when the command answered with an error', async () => {
    const remote = remoteReturning({ ok: true, value: { result: { kind: 'error', text: 'Usage: /approval-review on|off' } } })
    expect(await runCommandLine(remote, SESSION, '/approval-review nonsense')).toBe('Usage: /approval-review on|off')
  })

  it('reports a refused remote call with its code', async () => {
    const remote = remoteReturning({ ok: false, error: { code: 'forbidden', message: 'not allowed here' } })
    expect(await runCommandLine(remote, SESSION, '/approval-review off')).toBe('not allowed here (forbidden)')
  })

  it('reports a line the host never resolved', async () => {
    const remote = remoteReturning({ ok: true, value: undefined })
    expect(await runCommandLine(remote, SESSION, '/nope')).toContain('did not resolve')
  })

  it('reports a missing remote instead of throwing', async () => {
    expect(await runCommandLine(undefined, SESSION, '/approval-review off')).toContain('not mounted')
  })

  it('turns a thrown facade error into failure text', async () => {
    // Exactly the regression: a wrong arity used to surface as a silent no-op.
    const remote = { execute: async () => { throw new Error('boom') } } as unknown as CommandRemoteFace['commands']
    expect(await runCommandLine(remote, SESSION, '/approval-review on')).toContain('boom')
  })

  it('answers an empty error result with a generic refusal', async () => {
    const remote = remoteReturning({ ok: true, value: { result: { kind: 'error' } } })
    expect(await runCommandLine(remote, SESSION, '/approval-review on')).toContain('was refused')
  })
})
