/**
 * Browser half of the automatic-approval control surface.
 *
 * Contributes:
 * 1. a conversation tab — the approval ledger as a full page, beside 轨迹 /
 *    上下文 / 费用: every request, the reviewer's verdict and rationale, the
 *    routing policy, risk, route, timing, and the live counters;
 * 2. the access-mode glyph for this plugin's `approve-for-me` preset.
 *
 * The session-header card this plugin used to contribute is gone: it duplicated
 * the tab's ledger in a popover that the tab already renders full-page, and the
 * header is the most contended strip of the session chrome.
 *
 * It also decorates the access-mode control with the glyph for this plugin's
 * `approve-for-me` preset, which the harness's closed glyph table cannot know
 * about (see `./access-mode-glyph.ts`).
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
import { LedgerView } from './LedgerView.tsx'
import { installAccessModeGlyph } from './access-mode-glyph.ts'
import { reviewerRouteChoices, routesFromDirectory } from './model-choices.ts'
import { runCommandLine, type CommandRemoteFace } from './run-command.ts'
import type { ClientAuditView } from './types.ts'

/** Slot entry id; stable so a redeploy replaces its own row. */
export const VIEW_SLOT_ID = 'approval-review-ledger'

/** The conversation tab strip, beside 轨迹 / 上下文 / 费用. */
const VIEW_SLOT = 'conversation.view'

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
 * The client model directory this harness publishes for model picking.
 *
 * Read structurally and OPTIONALLY: it is what the composer's model seat and the
 * `/model` picker use, so it is the deployment's own answer to "which models are
 * configured here". `subagentModelSelectionPolicy` would be the tighter list,
 * but it is host-only (no `wire`), so it never reaches the browser.
 */
interface ModelDirectoriesFace {
  /**
   * @param sessionId - the session whose catalog to load.
   * @returns the loaded directory snapshot.
   */
  directoryFor(sessionId: SessionId): {
    load(): Promise<{ readonly groups?: unknown }>
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
  /**
   * Load the locally configured reviewer routes, as `provider/model`.
   * @returns the catalog's routes, or an empty list when unavailable.
   */
  loadModels: () => Promise<readonly string[]>
}

/** Reviewer routes this deployment offers, read from its own projections. */
function reviewerChoices(props: SessionActionProps, current: string | undefined): readonly string[] {
  return reviewerRouteChoices({
    current,
    sessionDefault: props.useProjection('modelSelection'),
    allowed: props.useProjection('subagentModelSelectionPolicy'),
  })
}

/** Render the full ledger tab. */
function ApprovalReviewLedger(props: SessionActionProps & ApprovalReviewInjected): React.JSX.Element {
  const view = props.useProjection('approvalReview') as ClientAuditView | undefined
  const current = view === undefined || view.reviewerModel.length === 0
    ? undefined
    : `${view.reviewerProvider.length > 0 ? `${view.reviewerProvider}/` : ''}${view.reviewerModel}`
  return LedgerView({
    view,
    zh: preferZh(),
    runCommand: props.runCommand,
    modelChoices: reviewerChoices(props, current),
    loadModels: props.loadModels,
  })
}

/**
 * Register the ledger tab and the access-mode glyph.
 * @param ctx - client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  // The glyph is decoration over a control this plugin's preset is part of; it
  // owns a style element, a few attributes, and one observer, all released by
  // the effect when the plugin unmounts or reloads.
  ctx.effect(() => installAccessModeGlyph(), 'approval-review: access-mode glyph')
  /**
   * The remote is resolved LAZILY, per call. Capturing `ctx.remote` in the
   * `apply` closure is wrong: `apply` can run before the remote facade finishes
   * mounting, and a captured `undefined` turns every click into a silent no-op
   * on a control that still LOOKS enabled. That was a real bug here.
   */
  const remoteOf = (): CommandRemoteFace['commands'] | undefined =>
    (ctx as unknown as { remote?: CommandRemoteFace }).remote?.commands

  /**
   * The model directory, resolved LAZILY for the same reason the command remote
   * is: this client half mounts before every service it may use is up, and a
   * captured `undefined` would permanently disable the picker.
   */
  const directoriesOf = (): ModelDirectoriesFace | undefined =>
    (ctx as unknown as { get?: (name: string) => unknown }).get?.('modelDirectories') as ModelDirectoriesFace | undefined

  /** The per-session business face the tab's seat uses. */
  // The seat hands the session id as a plain string; the command remote takes
  // the branded id, so the brand is reasserted at this one boundary.
  const inject = (rawSessionId: string): ApprovalReviewInjected => ({
    loadModels: async () => {
      const directories = directoriesOf()
      if (directories === undefined) return []
      try {
        // The catalog load is shared and cached by the harness, so opening the
        // picker costs nothing after the composer's own model seat has loaded.
        return routesFromDirectory(await directories.directoryFor(rawSessionId as SessionId).load())
      } catch {
        return []
      }
    },
    runCommand: async (line: string) => {
      // The remote is resolved per call (see `remoteOf`), and the line goes out
      // through `runCommandLine`, which owns the 3-business-argument arity and
      // the refusal mapping.
      return await runCommandLine(remoteOf(), rawSessionId as SessionId, line)
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
}
