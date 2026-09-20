/**
 * Runtime-only per-session bookkeeping: the per-turn reviewer budget, the
 * rejection circuit breaker, and one-shot `/approve` authorizations.
 *
 * Deliberately NOT durable-log state. These are behavioural guards, not facts
 * about what happened, so an out-of-tree plugin can hold them in memory without
 * touching the session log — which it must not extend (see `audit.ts` for the
 * full constraint). The durable record of every decision lives in the session
 * log the host already writes, and the card reads it from there.
 * @module dsh-approval-review/review-session
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** One-shot authorization recorded by `/approve`. */
export interface PendingOverride {
  /** Tool the denial was about. */
  readonly toolName: string
  /** Exact tool and unredacted argument digest; never a tool-wide grant. */
  readonly fingerprint: string
  /** When the authorization was recorded. */
  readonly at: number
  /** The record id the human picked, for the card's audit trail. */
  readonly reviewId?: string
}

/** Mutable per-session counters. */
export interface SessionState {
  /** Turn the counters below currently describe. */
  turn: number
  /** Reviewer calls already spent in {@link turn}. */
  reviewsThisTurn: number
  /** Reviewer failures already spent in {@link turn}. */
  failuresThisTurn: number
  /**
   * Why requests were left to the human chain in {@link turn}, by reason code.
   *
   * A ledger row that carries no rationale has two very different causes — the
   * reviewer never saw the request, or it saw it and declined to decide — and the
   * difference used to be visible only in a log an operator cannot reach.
   */
  delegationsThisTurn: Record<string, number>
  /** Consecutive refusals, reset by any approval or a new turn. */
  denialsStreak: number
  /** Rolling refusal window, newest last, bounded by the configured size. */
  window: boolean[]
  /** Whether the breaker has already tripped in this turn. */
  circuitTripped: boolean
  /** One-shot authorizations awaiting their retry. */
  readonly overrides: PendingOverride[]
}

/** Circuit-breaker and budget limits resolved from config. */
export interface GuardLimits {
  /** Maximum reviewer calls per open turn. */
  readonly maxReviewsPerTurn: number
  /** Maximum reviewer failures per open turn. */
  readonly maxFailuresPerTurn: number
  /** Consecutive refusals that trip the breaker. */
  readonly consecutiveDenials: number
  /** Refusals within the window that trip the breaker; 0 disables. */
  readonly windowDenials: number
  /** Rolling window size for {@link windowDenials}. */
  readonly windowSize: number
  /** How many recent denials `/approve` can address. */
  readonly maxPending: number
  /** Authorization lifetime in milliseconds. */
  readonly overrideTtlMs: number
}

/** Create the empty state for a session. */
export function createSessionState(): SessionState {
  return {
    turn: -1,
    reviewsThisTurn: 0,
    failuresThisTurn: 0,
    delegationsThisTurn: {},
    denialsStreak: 0,
    window: [],
    circuitTripped: false,
    overrides: [],
  }
}

/**
 * Owns the per-session counters. Keyed by `Session` object identity so a
 * finished session's state is collectable, and reset when the open turn
 * changes — the same boundary the durable ledger folds on.
 */
export class ReviewSessions {
  private readonly states = new WeakMap<Session, SessionState>()

  /**
   * Read (or lazily create) one session's counters.
   * @param session - the live session.
   * @returns its mutable state.
   */
  stateOf(session: Session): SessionState {
    let state = this.states.get(session)
    if (state === undefined) {
      state = createSessionState()
      this.states.set(session, state)
    }
    return state
  }

  /**
   * Account for one committed event so the counters share the ledger's turn
   * boundary. Called from the plugin's `session/event` observer.
   * @param session - the session the event belongs to.
   * @param event - the committed event.
   */
  observe(session: Session, event: { readonly type: string; readonly data: unknown }): void {
    const state = this.stateOf(session)
    if (event.type === 'turn/start') {
      const turn = (event.data as { turn?: number }).turn
      if (turn !== undefined && turn !== state.turn) {
        state.turn = turn
        state.reviewsThisTurn = 0
        state.failuresThisTurn = 0
        state.delegationsThisTurn = {}
        state.denialsStreak = 0
        state.window = []
        state.circuitTripped = false
      }
    }
  }

  /**
   * Record that a reviewer call was dispatched against the turn budget.
   * @param session - the session the review belongs to.
   */
  noteReview(session: Session): void {
    this.stateOf(session).reviewsThisTurn += 1
  }

  /**
   * Record that a reviewer call failed to answer, against its own budget so a
   * broken reviewer cannot be retried without bound.
   * @param session - the session the review belongs to.
   */
  noteFailure(session: Session): void {
    this.stateOf(session).failuresThisTurn += 1
  }

  /**
   * Fold one settled approval into the breaker. A refusal extends the streak
   * and the window; any grant resets the streak (matching Codex's "any
   * non-denial resets the consecutive-denial counter").
   * @param session - the session the decision belongs to.
   * @param refused - whether the action was refused.
   * @param limits - resolved breaker limits.
   */
  noteDecision(session: Session, refused: boolean, limits: GuardLimits): void {
    const state = this.stateOf(session)
    if (refused) {
      state.denialsStreak += 1
      state.window.push(true)
    } else {
      state.denialsStreak = 0
      state.window.push(false)
    }
    if (state.window.length > limits.windowSize) {
      state.window = state.window.slice(-limits.windowSize)
    }
  }

  /**
   * Whether the breaker is currently open for this session.
   * @param session - the session to test.
   * @param limits - resolved breaker limits.
   * @returns true when a fresh request must not go to the reviewer.
   */
  circuitOpen(session: Session, limits: GuardLimits): boolean {
    const state = this.stateOf(session)
    if (state.circuitTripped) return true
    if (state.denialsStreak >= limits.consecutiveDenials) {
      state.circuitTripped = true
      return true
    }
    if (limits.windowDenials > 0) {
      const denials = state.window.filter(Boolean).length
      if (denials >= limits.windowDenials) {
        state.circuitTripped = true
        return true
      }
    }
    return false
  }

  /**
   * Whether the turn still has reviewer budget.
   * @param session - the session to test.
   * @param limits - resolved budget limits.
   * @returns true when another reviewer call is allowed.
   */
  budgetAvailable(session: Session, limits: GuardLimits): boolean {
    return this.stateOf(session).reviewsThisTurn < limits.maxReviewsPerTurn
  }

  /**
   * Whether the reviewer has not already failed too often this turn. A reviewer
   * that keeps crashing must not be retried without bound: each attempt costs a
   * model call and delays the human the request should have reached.
   * @param session - the session to test.
   * @param limits - resolved budget limits.
   * @returns true when another attempt is allowed.
   */
  failureBudgetAvailable(session: Session, limits: GuardLimits): boolean {
    return this.stateOf(session).failuresThisTurn < limits.maxFailuresPerTurn
  }

  /** Reviewer failures recorded in the open turn. */
  failuresThisTurn(session: Session): number {
    return this.stateOf(session).failuresThisTurn
  }

  /**
   * Record that a request was handed to the rest of the answerer chain, and why.
   * @param session - the session the request belongs to.
   * @param code - short reason code (`no-call-id`, `preset`, `policy-human`, …).
   */
  noteDelegation(session: Session, code: string): void {
    const state = this.stateOf(session)
    state.delegationsThisTurn[code] = (state.delegationsThisTurn[code] ?? 0) + 1
  }

  /**
   * Delegation reasons recorded in the open turn, most frequent first.
   * @param session - the session to report on.
   * @returns one `code×count` label per distinct reason.
   */
  delegations(session: Session): readonly string[] {
    return Object.entries(this.stateOf(session).delegationsThisTurn)
      .sort((left, right) => right[1] - left[1])
      .map(([code, count]) => `${code}×${count}`)
  }

  /**
   * Record a one-shot `/approve` authorization, pruning expired ones.
   * @param session - the session the authorization belongs to.
   * @param override - the authorization to record.
   * @param limits - resolved override limits.
   */
  addOverride(session: Session, override: PendingOverride, limits: GuardLimits): void {
    const state = this.stateOf(session)
    const live = this.liveOverrides(session, limits)
    live.push(override)
    state.overrides.length = 0
    state.overrides.push(...live.slice(-limits.maxPending))
  }

  /**
   * Consume the newest authorization that matches a tool, if any.
   * @param session - the session to consume from.
   * @param toolName - the tool about to be reviewed.
   * @param limits - resolved override limits.
   * @returns the consumed authorization, or undefined.
   */
  consumeOverride(session: Session, toolName: string, limits: GuardLimits, fingerprint: string): PendingOverride | undefined {
    const state = this.stateOf(session)
    const live = this.liveOverrides(session, limits)
    state.overrides.length = 0
    state.overrides.push(...live)
    for (let index = state.overrides.length - 1; index >= 0; index -= 1) {
      const candidate = state.overrides[index]!
      if (candidate.toolName !== toolName || candidate.fingerprint !== fingerprint) continue
      state.overrides.splice(index, 1)
      return candidate
    }
    return undefined
  }

  /**
   * Authorizations that have not expired yet.
   * @param session - the session to read.
   * @param limits - resolved override limits.
   * @returns live authorizations, oldest first.
   */
  liveOverrides(session: Session, limits: GuardLimits): PendingOverride[] {
    const state = this.stateOf(session)
    if (limits.overrideTtlMs <= 0) return [...state.overrides]
    const cutoff = Date.now() - limits.overrideTtlMs
    return state.overrides.filter(override => override.at >= cutoff)
  }

  /**
   * Snapshot the counters the card shows for one session.
   * @param session - the session to read.
   * @param limits - resolved breaker limits.
   * @returns the live counter values.
   */
  snapshot(session: Session, limits: GuardLimits): {
    readonly consecutiveDenials: number
    readonly circuitOpen: boolean
    readonly pendingOverrides: number
  } {
    const state = this.stateOf(session)
    return {
      consecutiveDenials: state.denialsStreak,
      circuitOpen: state.circuitTripped
        || state.denialsStreak >= limits.consecutiveDenials
        || (limits.windowDenials > 0 && state.window.filter(Boolean).length >= limits.windowDenials),
      pendingOverrides: this.liveOverrides(session, limits).length,
    }
  }
}
