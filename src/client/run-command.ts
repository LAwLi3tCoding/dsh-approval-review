/**
 * One slash-command line sent from this plugin's browser half to the host.
 *
 * The remote facade's arity is the whole point of this module. The host
 * declares
 *
 * ```ts
 * // packages/interaction/commands/src/index.ts
 * @Remote
 * async execute(agent, line, submittedAttachments, signal)
 * ```
 *
 * — three business arguments, because a command may carry submitted
 * attachments. Calling it with two does not fail at compile time against a
 * HAND-WRITTEN structural type (this plugin declares its own), it fails at
 * runtime with `commands/execute expected 3 business argument(s) … got 2`, and
 * every button in the tab becomes a silent no-op. That is exactly what happened,
 * so the call and its error mapping live here with tests.
 * @module dsh-approval-review/client/run-command
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One command outcome as the remote facade reports it. */
export interface CommandRemoteResult {
  /** The handler's settled result, or undefined when the line did not resolve. */
  readonly value?: {
    readonly result: { readonly kind?: string; readonly text?: string }
  } | undefined
}

/** The command remote face this plugin drives. */
export interface CommandRemoteFace {
  readonly commands: {
    /**
     * Execute one command line in a session.
     * @param sessionId - the session the command runs in.
     * @param line - the full line, leading slash included.
     * @param attachments - submitted attachments; always `[]` for this plugin.
     * @returns the remote wrapper: `ok` discriminates refusal, `value` absence
     *   means the host never resolved the line.
     */
    execute(
      sessionId: SessionId,
      line: string,
      attachments: readonly unknown[],
    ): Promise<
      | { readonly ok: true; readonly value: CommandRemoteResult['value'] }
      | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
    >
  }
}

/**
 * Send one command line and reduce the outcome to "failure text, or null".
 *
 * A handler that answered `kind: 'error'` is a REFUSAL the operator must see
 * (`/approval-review nonsense` says so), while an unresolved line means the host
 * does not know the command at all. Both are returned as text, never thrown, so
 * the tab can show them next to the control that failed.
 * @param remote - the command remote, when the client has mounted it.
 * @param sessionId - the session the command runs in.
 * @param line - the full command line.
 * @returns null on success; a human-readable failure line otherwise.
 */
export async function runCommandLine(
  remote: CommandRemoteFace['commands'] | undefined,
  sessionId: SessionId,
  line: string,
): Promise<string | null> {
  if (remote === undefined) return 'the command remote is not mounted in this client'
  try {
    const result = await remote.execute(sessionId, line, [])
    if (!result.ok) return `${result.error.message} (${result.error.code})`
    if (result.value === undefined) return `the host did not resolve "${line}"`
    const text = result.value.result.text
    return result.value.result.kind === 'error'
      ? (text !== undefined && text.length > 0 ? text : `"${line}" was refused`)
      : null
  } catch (error: unknown) {
    return `"${line}" failed: ${String(error)}`
  }
}
