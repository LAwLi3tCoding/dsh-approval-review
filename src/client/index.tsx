/**
 * Browser half of the automatic-approval audit card.
 *
 * Contributes one Session-header action that opens the full approval ledger: the
 * reviewer's verdict and rationale for every request, the risk grade, the
 * reviewer route, the timing, and the live budget/breaker state. The host
 * provides the data through the `approvalReview` session projection, so this half
 * holds no state and reads only whole projection values.
 *
 * The card offers the one-shot override as the exact slash command line rather
 * than calling a client service, which keeps this half independent of the
 * client's command-remote shape and of the slice's React version.
 * @module dsh-approval-review/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pull in the slot-scope augmentation that types `ctx.slots`, the
// session-header slot name, and the `useProjection` standard prop.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ReviewCard } from './ReviewCard.tsx'
import type { ClientAuditView } from './types.ts'

/** Slot entry id; stable so a redeploy replaces its own row. */
export const SLOT_ID = 'approval-review-card'

/** The session-header action row this card contributes to. */
const SLOT_NAME = 'conversation.session.header.actions'

/** Required client service for slot registration. */
export const inject = ['slots']

/** Props the framework supplies to this session-scoped slot entry. */
interface HeaderActionProps {
  /** Host-computed projection values addressed by key. */
  readonly useProjection: (key: string) => unknown
}

/** Render the card from the session's audit projection. */
function ApprovalReviewAction(props: HeaderActionProps): React.JSX.Element {
  const view = props.useProjection('approvalReview') as ClientAuditView | undefined
  // The card is bilingual without the locale service: it picks its copy from the
  // browser language, which keeps this half free of a locale dependency.
  const zh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
  return ReviewCard({ view, zh })
}

/**
 * Register the audit card on the session-header action row.
 * @param ctx - client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject(SLOT_NAME, () => ctx.slots.register(
    {
      name: SLOT_NAME,
      id: SLOT_ID,
      // Beside the other session utilities, after the static session identity.
      order: 40,
    },
    ApprovalReviewAction,
  ))
}
