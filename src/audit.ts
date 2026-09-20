/**
 * The audit ledger and its session projection — the data source for the review
 * card page.
 *
 * Design constraint that shapes this module: **an out-of-tree plugin must not
 * append a custom session event type on the published host**. The persistence
 * read path refuses to interpret a log containing a type outside
 * `KNOWN_SESSION_EVENT_TYPES` unless the record carries the envelope's
 * `ignorable: true` marker, and `Session.append` cannot stamp that marker on any
 * published line — only the harness that owns the log can. Appending one would
 * therefore make the session unresumable.
 *
 * So the ledger adds NO event type. It folds the events the host already writes
 * (`approval/asked`, `approval/decided`, `tool/call`, `step/start`, `turn/*`,
 * `command/run`) into projection state, and correlates the reviewer's rationale
 * out of the refused tool result, which the plugin already rewrites durably.
 * Every field on the card is therefore reconstructible from the log alone.
 * @module dsh-approval-review/audit
 */

import { z } from 'zod'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'
// Type-only: bring the `command/run` session-event declaration into scope so the
// fold can narrow on it.
import type {} from '@deepseek-ai/dsh-commands/types'
import type { UserAuthorization, RiskLevel, ReviewOutcome, ToolPolicy } from './review-types.ts'
import { effectiveReviewerModel, JEV_ROUTE_PROVIDER } from './model-override.ts'

/** The projection key the card reads. */
export const AUDIT_PROJECTION_KEY = 'approvalReview'

/**
 * Resolve the routing policy of one approval request during the fold.
 *
 * The fold is a pure function of the log, so it cannot read the runtime's live
 * decision: it re-derives the SAME policy table from the deployment config. The
 * only input that differs from the runtime's is the argument text, which the
 * ledger keeps bounded ({@link ARGUMENT_PREVIEW_MAX}); a `field: 'arguments'`
 * rule whose match starts past that bound is therefore reported by its fallback
 * table entry rather than by that rule.
 */
export type AuditPolicyResolver = (
  toolName: string,
  reason: string | undefined,
  argumentsText: string,
) => { readonly policy: ToolPolicy; readonly source: string }

/** Fold inputs the log does not carry. */
export interface AuditFoldDefaults {
  /** Session-start value of the `/approval-review on|off` switch. */
  readonly enabledByDefault: boolean
  /**
   * Policy resolver used to stamp each `approval/asked` row. Omitted means the
   * row is stamped `ai`/`unrecorded`, which is only honest for a deployment
   * that routes everything to the reviewer.
   */
  readonly resolvePolicy?: AuditPolicyResolver
}


/** Hard cap on retained records; the newest survive. */
export const MAX_RECORDS = 200

/** Cap on the arguments preview stored per record. */
export const ARGUMENT_PREVIEW_MAX = 1200

/**
 * Prefix that marks a refusal as this plugin's work, written into the tool
 * result the model sees. It is the durable carrier of the reviewer's rationale:
 * because the tool result is a logged `tool/result` event, folding it back is
 * what makes the card reconstructible without a custom event type.
 */
export const REVIEW_MARKER = '[approval-review]'

/** One rendered audit entry. Every field is plain JSON. */
export interface AuditRecord {
  /** Fresh id minted when the request was reviewed. */
  readonly reviewId: string
  /** Session-unique sequence for stable ordering in the card. */
  readonly seq: number
  /** Tool the request was about. */
  readonly toolName: string
  /** The exact tool call, when the asker supplied one. */
  readonly callId?: string
  /** Turn the request arrived in. */
  readonly turn: number
  /** Step the request arrived in. */
  readonly step: number
  /** Epoch milliseconds when the request was accepted for review. */
  readonly startedAt: number
  /** Effective tool policy at decision time. */
  readonly policy: 'ai' | 'human' | 'never'
  /** Which rule selected that policy. */
  readonly policySource: string
  /** The asker's own reason for requesting approval. */
  readonly askReason?: string
  /** Redaction-free arguments preview (already in the user's own log). */
  readonly argumentsPreview?: string
  /** How the request was finally resolved, from the host's own decision event. */
  readonly outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  /** The reviewer's rationale, folded out of the refused tool result. */
  readonly reason?: string
  /** Actionable safer alternative the reviewer suggested. */
  readonly suggestion?: string
  /** Risk grade the reviewer reported. */
  readonly userAuthorization?: UserAuthorization
  readonly risk?: RiskLevel
  /** Reviewer route, when it is recorded in the refusal marker. */
  readonly reviewerRoute?: string
  /** Reviewer duration in milliseconds. */
  readonly durationMs?: number
  /** Convenience verdict for the card's tone: did this end in a refusal? */
  readonly refused: boolean
  /** True when the reviewer was uncertain rather than decisive. */
  readonly uncertain: boolean
  /** True when a one-shot `/approve` override authorized the retry. */
  readonly overridden: boolean
}

/** Client-visible projection value: the ledger for one session. */
export interface AuditView {
  /** Newest-first audit entries. */
  readonly records: readonly AuditRecord[]
  /** Effective auto-review switch (`enabledByDefault` already applied). */
  readonly enabled: boolean
  /** Reviewer calls already spent in the open turn. */
  readonly reviewsThisTurn: number
  /** Per-turn reviewer budget in force. */
  readonly maxReviewsPerTurn: number
  /** Consecutive denials, counting the open turn. */
  readonly consecutiveDenials: number
  /** Whether the rejection circuit breaker is currently open. */
  readonly circuitOpen: boolean
  /** Cumulative reviewed-request count for the session. */
  readonly total: number
  /** Successful refuse count for the session (compact and plain, not a delta). */
  readonly refused: number
  /** One-shot overrides still usable. */
  readonly pendingOverrides: number
  /**
   * The reviewer model actually in force for this session: the durable override
   * when one was set, else the deployment default (`''` = inherit the session
   * model).
   */
  readonly reviewerModel: string
  /**
   * Provider half of the effective reviewer route (`''` = the deployment
   * default, which itself falls back to the calling agent's provider).
   */
  readonly reviewerProvider: string
  /**
   * Which engine answers reviews IN THIS SESSION: the deployment's choice, unless
   * the session selected a reviewer from the other engine through the picker.
   * This is what the header pill shows and what the runtime dispatches on.
   */
  readonly reviewerEngine: 'llm' | 'jev'
  /**
   * Whether the picker may offer Jev models at all: the deployment acknowledged
   * that evidence leaves the machine (`reviewer.jev.allowEgress`). A session
   * selection can never grant this itself.
   */
  readonly jevSelectable: boolean
}

/** Raw projection state; the wire view is derived from it. */
export interface AuditState {
  readonly records: readonly AuditRecord[]
  /** In-flight approvals by `approval/asked` id, settled by `approval/decided`. */
  readonly pending: Readonly<Record<string, AuditRecord>>
  /** `tool/call` arguments by callId, for the preview. */
  readonly arguments: Readonly<Record<string, string>>
  readonly turn: number
  readonly step: number
  readonly enabledOverride?: boolean
  /**
   * Durable per-session reviewer ROUTE override, from
   * `/approval-review model [<provider>/]<model>`. Both halves are written
   * together so a cross-provider choice cannot end up asking the session's
   * provider for a model it does not serve.
   */
  readonly modelOverride?: string
  /** Provider half of {@link modelOverride}; absent means the configured route. */
  readonly providerOverride?: string
  /**
   * Engine the session selection implies, written alongside the provider half.
   *
   * The picker lists reviewers from both engines, so choosing a row has to be able
   * to switch which engine answers; a bare model id leaves this unset and keeps the
   * deployment's engine.
   */
  readonly engineOverride?: 'llm' | 'jev'
  readonly reviewsThisTurn: number
  readonly denialsStreak: number
  readonly window: readonly boolean[]
  readonly total: number
  readonly refused: number
  readonly nextSeq: number
  readonly pendingOverrides: number
}

// The merge target is the `types` outlet, not the package root: that is the
// module whose interfaces the projection registry's constraints actually read,
// and the root only re-exports them.
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Audit ledger + live counters for the review card. */
    approvalReview: AuditView
  }
  interface SessionProjectionStateMap {
    /** Raw fold state behind {@link SessionProjectionMap.approvalReview}. */
    approvalReview: AuditState
  }
}


/** The empty ledger for a fresh session. */
export function initAuditState(): AuditState {
  return {
    records: [],
    pending: {},
    arguments: {},
    turn: 0,
    step: 0,
    reviewsThisTurn: 0,
    denialsStreak: 0,
    window: [],
    total: 0,
    refused: 0,
    nextSeq: 1,
    pendingOverrides: 0,
  }
}

/**
 * Fold one committed session event into the ledger.
 *
 * Pure and synchronous per the projection contract. An event the unit does not
 * care about returns the SAME state reference so the drive does no work.
 * @param state - state covering all prior events.
 * @param event - the next committed session event.
 * @param defaults - deployment values the view needs but the log does not carry.
 * @returns the next state, or the same reference.
 */
export function applyAuditEvent(
  state: AuditState,
  event: SessionEvent,
  defaults: AuditFoldDefaults,
): AuditState {
  switch (event.type) {
    case 'turn/start':
      // Counters are per-turn: the breaker and the budget both reset here, and
      // any denial streak from a previous turn must not bleed into this one.
      return { ...state, turn: event.data.turn, step: 0, reviewsThisTurn: 0, denialsStreak: 0, window: [] }

    case 'step/start':
      return state.step === event.data.step ? state : { ...state, step: event.data.step }

    case 'tool/call': {
      const preview = previewArguments(event.data.arguments)
      if (preview === undefined) return state
      return { ...state, arguments: { ...state.arguments, [event.data.callId]: preview } }
    }

    case 'approval/asked': {
      // A `human`/`never` request still belongs on the card: the user asked for a
      // record of every approval decision, not only the ones a model judged. The
      // row carries the policy that ROUTED it, re-derived from the deployment
      // config, so a delegated request never masquerades as a reviewed one.
      const seq = state.nextSeq
      const callId = event.data.callId
      const preview = callId === undefined ? undefined : state.arguments[callId]
      const routed = defaults.resolvePolicy === undefined
        ? { policy: 'ai' as ToolPolicy, source: 'unrecorded' }
        : defaults.resolvePolicy(event.data.toolName, event.data.reason, preview ?? '')
      const record: AuditRecord = {
        reviewId: event.data.id,
        seq,
        toolName: event.data.toolName,
        ...callId === undefined ? {} : { callId },
        turn: state.turn,
        step: state.step,
        startedAt: event.time,
        policy: routed.policy,
        policySource: routed.source,
        ...event.data.reason === undefined ? {} : { askReason: event.data.reason },
        ...preview === undefined ? {} : { argumentsPreview: preview },
        refused: false,
        uncertain: false,
        overridden: false,
      }
      const pendingOverrides = record.overridden ? state.pendingOverrides - 1 : state.pendingOverrides
      return {
        ...state,
        pending: { ...state.pending, [event.data.id]: record },
        records: cap([record, ...state.records]),
        total: state.total + 1,
        nextSeq: seq + 1,
        pendingOverrides,
      }
    }

    case 'approval/decided': {
      const pending = state.pending[event.data.id]
      if (pending === undefined) return state
      const rest = { ...state.pending }
      delete rest[event.data.id]
      const refused = event.data.outcome !== 'allowed-once'
      const settled: AuditRecord = { ...pending, outcome: event.data.outcome, refused }
      const window = [...state.window, refused].slice(-200)
      return {
        ...state,
        pending: rest,
        records: cap(state.records.map(record => record.reviewId === event.data.id ? settled : record)),
        denialsStreak: refused ? state.denialsStreak + 1 : 0,
        window,
        refused: state.refused + (refused ? 1 : 0),
      }
    }

    case 'command/run': {
      // `/approval-review on|off` is the durable switch; replay IS the state, so
      // a restart or resume lands on the same answer without extra storage.
      if (event.data.name !== COMMAND_NAME) return state
      const args = (event.data.args ?? '').trim().toLowerCase()
      const action = args.split(/\s+/u)[0]
      if (action === 'on') return { ...state, enabledOverride: true }
      if (action === 'off') return { ...state, enabledOverride: false }
      if (action === 'approve') return state // Pending grants live only in ReviewSessions; never revive on replay.
      if (action === 'model') {
        const value = args.split(/\s+/u).slice(1).join(' ').trim()
        // `model default` clears the whole selection back to the deployment default.
        if (value.length === 0 || value === 'default') {
          // Drop the keys rather than set them to undefined: the state is
          // persisted JSON, and explicit undefined keys are noise the cache
          // has to carry.
          const { modelOverride: _m, providerOverride: _p, engineOverride: _e, ...rest } = state
          return rest
        }
        // `[<provider>/]<model>`: a model id may itself contain `/` in some
        // registries, so only an exact two-part split with a non-empty provider
        // counts as the provider form.
        const slash = value.indexOf('/')
        if (slash > 0 && slash < value.length - 1 && !value.slice(slash + 1).includes('/')) {
          const provider = value.slice(0, slash)
          return {
            ...state,
            // The provider half NAMES THE ENGINE: `typesafe/<model>` is a Jev
            // selection, anything else is an LLM route. That is what lets one
            // picker row mean something under either deployment engine, instead
            // of being listed and then discarded by the engine in force.
            engineOverride: provider === JEV_ROUTE_PROVIDER ? 'jev' : 'llm',
            providerOverride: provider,
            modelOverride: value.slice(slash + 1),
          }
        }
        // A bare model id keeps the engine in force and replaces only the model:
        // the two travel together, and keeping a stale provider is how a session
        // ends up asking the wrong vendor for a model id.
        const { providerOverride: _stale, engineOverride: _staleEngine, ...rest } = state
        return { ...rest, modelOverride: value }
      }
      return state
    }

    case 'tool/result': {
      // The refusal marker is where the reviewer's rationale survives. Fold it
      // back onto the matching record so the card can show WHY, not just that.
      const callId = callIdOfToolResult(event)
      if (callId === undefined) return state
      const marker = toolResultTexts(event).find(text => text.includes(REVIEW_MARKER))
      if (marker === undefined) return state
      const parsed = parseReviewMarker(marker)
      if (parsed === undefined) return state
      let changed = false
      const records = state.records.map((record) => {
        if (record.callId !== callId || record.reason !== undefined) return record
        changed = true
        return {
          ...record,
          reason: parsed.reason,
          ...parsed.suggestion === undefined ? {} : { suggestion: parsed.suggestion },
          ...parsed.risk === undefined ? {} : { risk: parsed.risk },
          ...parsed.userAuthorization === undefined ? {} : { userAuthorization: parsed.userAuthorization },
          ...parsed.reviewerRoute === undefined ? {} : { reviewerRoute: parsed.reviewerRoute },
          ...parsed.durationMs === undefined ? {} : { durationMs: parsed.durationMs },
          uncertain: parsed.uncertain,
          overridden: parsed.overridden === true,
        }
      })
      return changed ? { ...state, records } : state
    }

    default:
      return state
  }
}

/** Derive the client-visible ledger from raw state. */
export function auditView(
  state: AuditState,
  defaults: {
    readonly enabledByDefault: boolean
    readonly maxReviewsPerTurn: number
    readonly breakerTrips: boolean
    readonly defaultReviewerModel: string
    /** Deployment default provider half; `''` inherits the calling agent's. */
    readonly defaultReviewerProvider: string
    /** Engine the deployment selected; not influenced by any session override. */
    readonly defaultReviewerEngine: 'llm' | 'jev'
    /** `reviewer.jev.allowEgress`: whether a session may switch to Jev at all. */
    readonly defaultJevPermitted: boolean
  },
): AuditView {
  // The card shows the reviewer actually in force, resolved by the same rule the
  // runtime routes with — including the engine, which a session selection may
  // switch but never past the deployment's egress acknowledgement.
  const identity = effectiveReviewerModel({
    engine: defaults.defaultReviewerEngine,
    ...state.engineOverride === undefined ? {} : { overrideEngine: state.engineOverride },
    ...state.providerOverride === undefined ? {} : { overrideProvider: state.providerOverride },
    ...state.modelOverride === undefined ? {} : { overrideModel: state.modelOverride },
    defaultProvider: defaults.defaultReviewerProvider,
    defaultModel: defaults.defaultReviewerModel,
    jevPermitted: defaults.defaultJevPermitted,
  })
  return {
    records: state.records,
    enabled: state.enabledOverride ?? defaults.enabledByDefault,
    reviewsThisTurn: state.reviewsThisTurn,
    maxReviewsPerTurn: defaults.maxReviewsPerTurn,
    consecutiveDenials: state.denialsStreak,
    circuitOpen: defaults.breakerTrips,
    total: state.total,
    refused: state.refused,
    pendingOverrides: state.pendingOverrides,
    reviewerModel: identity.model,
    reviewerProvider: identity.provider,
    reviewerEngine: identity.engine,
    jevSelectable: defaults.defaultJevPermitted,
  }
}

/** The command that owns the durable switch. */
export const COMMAND_NAME = 'approval-review'

/** Keep only the newest {@link MAX_RECORDS} entries. */
function cap(records: readonly AuditRecord[]): readonly AuditRecord[] {
  return records.length <= MAX_RECORDS ? records : records.slice(0, MAX_RECORDS)
}

/** Every text block inside a tool result, including nested ones. */
function toolResultTexts(event: Extract<SessionEvent, { type: 'tool/result' }>): string[] {
  const texts: string[] = []
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'text') texts.push(block.text)
      else if (block.type === 'tool-result') walk(block.content)
    }
  }
  walk(event.data.message.content)
  return texts
}

/** Bound and normalize one raw argument string for the preview. */
function previewArguments(raw: string): string | undefined {
  if (raw.length === 0) return undefined
  const trimmed = raw.trim()
  return trimmed.length <= ARGUMENT_PREVIEW_MAX
    ? trimmed
    : `${trimmed.slice(0, ARGUMENT_PREVIEW_MAX)}…`
}

/**
 * Recover the callId a `tool/result` belongs to. The event carries the tool
 * result message, whose block identifies the call.
 * @param event - a committed `tool/result` event.
 * @returns the call id, when the message shape exposes one.
 */
function callIdOfToolResult(event: Extract<SessionEvent, { type: 'tool/result' }>): string | undefined {
  for (const block of event.data.message.content) {
    if (block.type === 'tool-result') return block.toolCallId
  }
  return undefined
}

/** Fields recovered out of a refusal marker. */
interface ParsedMarker {
  readonly overridden?: boolean
  readonly reason: string
  readonly suggestion?: string
  readonly userAuthorization?: UserAuthorization
  readonly risk?: RiskLevel
  readonly reviewerRoute?: string
  readonly durationMs?: number
  readonly uncertain: boolean
}

const RISK_VALUES: readonly string[] = ['low', 'medium', 'high', 'critical']

/**
 * Parse the refusal marker the plugin writes into a tool result. The format is
 * fixed by {@link formatReviewMarker}, so this stays a pure, testable inverse.
 * @param text - the tool result text containing the marker.
 * @returns the recovered fields, or undefined when the marker is malformed.
 */
export function parseReviewMarker(text: string): ParsedMarker | undefined {
  const start = text.indexOf(REVIEW_MARKER)
  if (start < 0) return undefined
  const body = text.slice(start + REVIEW_MARKER.length)
  const lines = body.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  let reason: string | undefined
  let suggestion: string | undefined
  let userAuthorization: UserAuthorization | undefined
  let risk: RiskLevel | undefined
  let reviewerRoute: string | undefined
  let durationMs: number | undefined
  let overridden = false
  let uncertain = false
  for (const line of lines) {
    if (line === 'exact-action-approval: true') overridden = true
    else if (line.startsWith('reason:')) reason = line.slice('reason:'.length).trim()
    else if (line.startsWith('suggestion:')) suggestion = line.slice('suggestion:'.length).trim()
    else if (line.startsWith('authorization:')) {
      const value = line.slice('authorization:'.length).trim()
      if (['high', 'medium', 'low', 'unknown'].includes(value)) userAuthorization = value as UserAuthorization
    } else if (line.startsWith('risk:')) {
      const value = line.slice('risk:'.length).trim()
      if (RISK_VALUES.includes(value)) risk = value as RiskLevel
    } else if (line.startsWith('reviewer:')) reviewerRoute = line.slice('reviewer:'.length).trim()
    else if (line.startsWith('duration:')) {
      const value = Number.parseInt(line.slice('duration:'.length).trim(), 10)
      if (Number.isFinite(value)) durationMs = value
    } else if (line.startsWith('confidence:')) uncertain = line.slice('confidence:'.length).trim() === 'uncertain'
  }
  if (reason === undefined) return undefined
  return {
    reason,
    uncertain,
    ...overridden ? { overridden: true } : {},
    ...suggestion === undefined || suggestion.length === 0 ? {} : { suggestion },
    ...risk === undefined ? {} : { risk },
    ...userAuthorization === undefined ? {} : { userAuthorization },
    ...reviewerRoute === undefined || reviewerRoute.length === 0 ? {} : { reviewerRoute },
    ...durationMs === undefined ? {} : { durationMs },
  }
}

/**
 * Render the refusal marker appended to a refused tool result. The model reads
 * this text, so it states the decision, the rationale, and — critically — that
 * circumvention is not the next step.
 * @param input - the verdict facts to record.
 * @returns the marker block, terminated by a newline.
 */
export function formatReviewMarker(input: {
  readonly overridden?: boolean
  readonly reason: string
  readonly userAuthorization?: UserAuthorization
  readonly risk?: RiskLevel
  readonly suggestion?: string
  readonly reviewerRoute?: string
  readonly durationMs?: number
  readonly uncertain?: boolean
}): string {
  // Every field is written on one line: the parser reads the marker back by
  // line, so a newline inside a value would forge a field boundary.
  const lines = [
    REVIEW_MARKER,
    ...input.overridden === true ? ['exact-action-approval: true'] : [],    `reason: ${oneLine(input.reason)}`,
    ...input.suggestion === undefined ? [] : [`suggestion: ${oneLine(input.suggestion)}`],
    ...input.risk === undefined ? [] : [`risk: ${input.risk}`],
    ...input.userAuthorization === undefined ? [] : [`authorization: ${input.userAuthorization}`],
    ...input.reviewerRoute === undefined ? [] : [`reviewer: ${oneLine(input.reviewerRoute)}`],
    ...input.durationMs === undefined ? [] : [`duration: ${input.durationMs}`],
    `confidence: ${input.uncertain === true ? 'uncertain' : 'decided'}`,
  ]
  return lines.join('\n')
}

/** Collapse every whitespace run so one field can never span two lines. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** The projections this module declares. */
export type AuditProjectionKey = typeof AUDIT_PROJECTION_KEY

/**
 * A definition whose `wire` view is definitely present. The registry's overload
 * for a client-visible key expresses this through a conditional type the
 * compiler cannot discharge for a plugin-declared key, so the concrete shape is
 * named here and the registration path uses it directly.
 */
export type WiredProjectionDefinition<K extends AuditProjectionKey> =
  Omit<ProjectionDefinition<K, AuditState>, 'wire'> & {
    readonly wire: NonNullable<ProjectionDefinition<K, AuditState>['wire']>
  }

/**
 * Build the projection unit. `defaults` closes over config so the fold and the
 * view are pure functions of the log plus deployment settings.
 * @param defaults - deployment values the log does not carry.
 * @returns the projection definition to register.
 */
export function createAuditProjection(defaults: AuditFoldDefaults & {
  readonly maxReviewsPerTurn: number
  readonly breakerTrips: (state: AuditState) => boolean
  readonly defaultReviewerModel: string
  readonly defaultReviewerProvider: string
  readonly defaultReviewerEngine: 'llm' | 'jev'
  readonly defaultJevPermitted: boolean
}): WiredProjectionDefinition<AuditProjectionKey> {
  const stateSchema = z.object({
    records: z.array(z.any()),
    pending: z.record(z.string(), z.any()),
    arguments: z.record(z.string(), z.string()),
    turn: z.number(),
    step: z.number(),
    enabledOverride: z.boolean().optional(),
    modelOverride: z.string().optional(),
    providerOverride: z.string().optional(),
    engineOverride: z.string().optional(),
    reviewsThisTurn: z.number(),
    denialsStreak: z.number(),
    window: z.array(z.boolean()),
    total: z.number(),
    refused: z.number(),
    nextSeq: z.number(),
    pendingOverrides: z.number(),
  }) as unknown as z.ZodType<AuditState>
  return {
    key: AUDIT_PROJECTION_KEY,
    stateSchema,
    stateVersion: 1,
    init: (_header: SessionHeader, _inheritedEventCount: SessionLogOffset) => initAuditState(),
    apply: (state, event) => applyAuditEvent(state, event, defaults),
    wire: {
      viewSchema: z.any() as unknown as z.ZodType<AuditView>,
      view: state => auditView(state, {
        enabledByDefault: defaults.enabledByDefault,
        maxReviewsPerTurn: defaults.maxReviewsPerTurn,
        breakerTrips: defaults.breakerTrips(state),
        defaultReviewerModel: defaults.defaultReviewerModel,
        defaultReviewerProvider: defaults.defaultReviewerProvider,
        defaultReviewerEngine: defaults.defaultReviewerEngine,
        defaultJevPermitted: defaults.defaultJevPermitted,
      }),
    },
  }
}

/** Exhaustiveness note: the module owns no other projection key. */
export type AuditOutcome = ReviewOutcome
