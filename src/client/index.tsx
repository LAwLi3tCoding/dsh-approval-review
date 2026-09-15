/**
 * Browser half of the automatic-approval control surface.
 *
 * Contributes TWO surfaces:
 * 1. a Session-header action opening the full approval ledger — every request,
 *    the reviewer's verdict and rationale, risk, route, timing, and live
 *    counters;
 * 2. a composer-dock toggle — the independent "who decides" axis sitting beside
 *    the sandbox access-mode chip, mirroring Codex's separation of
 *    `sandbox_mode` from `approvals_reviewer`.
 *
 * The host provides data through the `approvalReview` session projection, so
 * this half reads only whole projection values. Both surfaces drive the host
 * through the slash command — the same path a human typing it would take — which
 * keeps this half free of any assumption about the host's internal services.
 * @module dsh-approval-review/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the slot-scope augmentation that types `ctx.slots`, the session
// standard props (`useProjection`), and the composer dock slot name.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ReviewCard } from './ReviewCard.tsx'
import { ReviewToggle } from './ReviewToggle.tsx'
import { LedgerView } from './LedgerView.tsx'
import type { ClientAuditView } from './types.ts'

/** Slot entry ids; stable so a redeploy replaces its own rows. */
export const CARD_SLOT_ID = 'approval-review-card'
/** Composer toggle entry id. */
export const TOGGLE_SLOT_ID = 'approval-review-toggle'
/** Conversation tab entry id. */
export const VIEW_SLOT_ID = 'approval-review-ledger'

/** The session-header action row the ledger card contributes to. */
const CARD_SLOT = 'conversation.session.header.actions'
/** The conversation tab strip, beside 轨迹 / 上下文 / 费用. */
const VIEW_SLOT = 'conversation.view'
/**
 * The composer tool row. `conversation.input.left` is a `list` slot with no
 * owner, which is what lets this sit INSIDE the row beside the access-mode chip
 * rather than above the card (the composer dock renders below the card).
 */
const TOGGLE_SLOT = 'conversation.input.left'

/**
 * Required client services.
 *
 * `remote.commands` is a named remote SERVICE, not a plain property: the client
 * remote facade throws `cannot get property "remote.commands" without inject`
 * unless the key is declared here. Declaring `remote` alone is not enough, which
 * is exactly the bug this cost once.
 */
export const inject = ['slots', 'remote', 'remote.commands']

/**
 * The command-remote subset this half drives. Spelled structurally so the
 * browser half keeps building against the harness packages it truly needs.
 */
interface CommandRemoteFace {
  readonly commands: {
    /**
     * Execute one slash-command line in a session.
     * @param sessionId - the session the command runs in.
     * @param line - the full command line, leading slash included.
     * @returns the remote outcome; `ok` is false when the host refused it.
     */
    execute(sessionId: SessionId, line: string): Promise<{ readonly ok: boolean }>
  }
}

/** Props the framework supplies to a session-scoped slot entry. */
interface SessionActionProps {
  /** Host-computed projection values addressed by key. */
  readonly useProjection: (key: string) => unknown
  /** Current session identity, absent while no session is selected. */
  readonly sessionId?: SessionId
}

/** Whether copy should be Chinese, from the browser language. */
function preferZh(): boolean {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
}

/**
 * The business face the slot framework injects per session. Carrying the session
 * id here — rather than in module state — is what makes the control correct for
 * whichever session it is rendered in.
 */
export interface ApprovalReviewInjected {
  /**
   * Execute one approval-review command line in this session.
   * @param line - the full command line, leading slash included.
   * @returns null when the host admitted it; a failure line otherwise.
   */
  runCommand: (line: string) => Promise<string | null>
}

/** Render the ledger card from the session's audit projection. */
function ApprovalReviewCard(props: SessionActionProps & ApprovalReviewInjected): React.JSX.Element {
  const view = props.useProjection('approvalReview') as ClientAuditView | undefined
  return ReviewCard({ view, zh: preferZh(), runCommand: props.runCommand })
}

/** Render the full ledger tab. */
function ApprovalReviewLedger(props: SessionActionProps & ApprovalReviewInjected): React.JSX.Element {
  const view = props.useProjection('approvalReview') as ClientAuditView | undefined
  return LedgerView({ view, zh: preferZh(), runCommand: props.runCommand })
}

/** Render the composer "who decides" toggle. */
function ApprovalReviewToggle(props: SessionActionProps & ApprovalReviewInjected): React.JSX.Element {
  const view = props.useProjection('approvalReview') as ClientAuditView | undefined
  return ReviewToggle({ view, zh: preferZh(), runCommand: props.runCommand })
}

/**
 * Register the ledger card and the composer toggle.
 * @param ctx - client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  /**
   * The remote is resolved LAZILY, per call. Capturing `ctx.remote` in the
   * `apply` closure is wrong: `apply` can run before the remote facade finishes
   * mounting, and a captured `undefined` turns every click into a silent no-op
   * on a control that still LOOKS enabled. That was a real bug here.
   */
  const remoteOf = (): CommandRemoteFace['commands'] | undefined =>
    (ctx as unknown as { remote?: CommandRemoteFace }).remote?.commands

  /** The per-session business face both seats share. */
  // The seat hands the session id as a plain string; the command remote takes
  // the branded id, so the brand is reasserted at this one boundary.
  const inject = (rawSessionId: string): ApprovalReviewInjected => ({
    runCommand: async (line: string) => {
      const commands = remoteOf()
      if (commands === undefined) return 'the command remote is not mounted in this client'
      const sessionId = rawSessionId as SessionId
      try {
        const result = await commands.execute(sessionId, line)
        if (!result.ok) return `the host refused "${line}"`
        return null
      } catch (error: unknown) {
        return `"${line}" failed: ${String(error)}`
      }
    },
  })

  ctx.slots.inject(VIEW_SLOT, () => ctx.slots.register(
    {
      name: VIEW_SLOT,
      id: VIEW_SLOT_ID,
      // After the built-in 轨迹 tab so the strip keeps its familiar order.
      order: 40,
      label: () => (preferZh() ? '审批' : 'Approvals'),
      inject,
    },
    ApprovalReviewLedger,
  ))

  ctx.slots.inject(TOGGLE_SLOT, () => ctx.slots.register(
    {
      name: TOGGLE_SLOT,
      id: TOGGLE_SLOT_ID,
      // Left of the access-mode chip, so the two axes read as a pair.
      order: -10,
      inject,
    },
    ApprovalReviewToggle,
  ))

  ctx.slots.inject(CARD_SLOT, () => ctx.slots.register(
    {
      name: CARD_SLOT,
      id: CARD_SLOT_ID,
      // Beside the other session utilities, after the static session identity.
      order: 40,
      inject,
    },
    ApprovalReviewCard,
  ))
}
