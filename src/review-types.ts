/**
 * Domain vocabulary for the approval-review capability: how an approval request
 * is classified, what the reviewer answered, and the record that the audit card
 * renders. Kept free of Cordis and host-service imports so the pure rules and
 * the browser half can share it.
 * @module dsh-approval-review/review-types
 */

/**
 * Which answerer owns an approval request.
 *
 * - `ai` — this plugin's reviewer model decides (`allowed-once` / `rejected`).
 * - `human` — delegate via `next()` to the rest of the answerer chain (a UI
 *   prompt, ACP, …); the plugin never short-circuits the chain.
 * - `never` — deterministic `rejected` with an explanatory marker, no reviewer
 *   call and no human prompt. The "hard disable" stance for a tool family.
 */
export type ToolPolicy = 'ai' | 'human' | 'never'

/** Risk grades a reviewer may report, ordered from least to most dangerous. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

/** Every {@link RiskLevel}, least to most dangerous (index is the rank). */
export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical']

/** Rank a risk level for threshold comparison; `low` is 0. */
export function riskRank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level)
}

/** The reviewer's closed decision vocabulary. */
export type ReviewDecision = 'allow' | 'deny'

/**
 * How this plugin resolved one approval request. The first three are reviewer
 * verdicts; the rest are the deterministic paths that never consulted a model.
 */
export type ReviewOutcome =
  /** Reviewer returned `allow`. */
  | 'allowed'
  /** Reviewer returned `deny`. */
  | 'denied'
  /** Reviewer was uncertain and the configured `onUncertain` policy delegated. */
  | 'uncertain'
  /** Reviewer failed, timed out, or answered off-schema; fail-closed policy applied. */
  | 'fallback'
  /** A `never`-policy tool: rejected without review. */
  | 'policy-never'
  /** The per-turn review budget was exhausted; delegated to the human chain. */
  | 'budget-exhausted'
  /** The rejection circuit breaker had tripped; delegated to the human chain. */
  | 'circuit-open'
  /** A one-shot `/approve` override authorized this attempt. */
  | 'override'

/** Why a request was left to the human answerer instead of being reviewed. */
export type DelegateReason =
  /** The tool's configured policy is `human`. */
  | 'policy-human'
  /** No reviewer route could be resolved for this agent. */
  | 'no-route'
  /** The session's approval policy is `never`; the seam rejects before dispatch. */
  | 'policy-never'
  /** Reviewer returned `uncertain` and `onUncertain` is `delegate`. */
  | 'uncertain'
  /** Reviewer failure and `fallbackPolicy` is `delegate`. */
  | 'reviewer-failure'
  /** Per-turn review budget exhausted and `budgetExhausted` is `delegate`. */
  | 'budget'
  /** Circuit breaker open and `circuitBreaker.action` is `delegate`. */
  | 'circuit'
  /** The request carried no call id, so the proposed action could not be read. */
  | 'no-call-id'

/**
 * One durable-visible audit entry: everything a human needs to judge why an
 * action was allowed or refused, rendered by the review card. Every reviewed
 * request produces exactly one of these, whatever the outcome.
 */
export interface ReviewRecord {
  /** Fresh id for this review, stable across the record's lifetime. */
  readonly reviewId: string
  /** Exact session the reviewed request belongs to. */
  readonly sessionId: string
  /** Tool the request was about. */
  readonly toolName: string
  /** The exact tool call when the asker supplied one. */
  readonly callId?: string
  /** Epoch milliseconds when the review started. */
  readonly startedAt: number
  /** How this request was resolved. */
  readonly outcome: ReviewOutcome
  /** The policy that routed this request to the reviewer. */
  readonly policy: ToolPolicy
  /** The rule or table entry that selected {@link policy}, for auditability. */
  readonly policySource: string
  /** Reviewer-reported risk grade, when the reviewer answered. */
  readonly risk?: RiskLevel
  /** One-sentence reviewer rationale, or this plugin's own explanation. */
  readonly reason: string
  /** The reviewer's actionable advice for the model, when it gave any. */
  readonly suggestion?: string
  /** Reviewer route that produced the verdict (`provider/model`). */
  readonly reviewerRoute?: string
  /** Wall-clock duration of the reviewer call in milliseconds. */
  readonly durationMs: number
  /** The exact approval outcome handed back to the caller. */
  readonly approvalOutcome: 'allowed-once' | 'rejected' | 'delegated'
  /** How many consecutive denials preceded this record, after it was folded in. */
  readonly consecutiveDenials: number
  /** Redacted, length-capped preview of the reviewed arguments. */
  readonly argumentsPreview?: string
  /** Why the request was delegated, when {@link outcome} is a delegation. */
  readonly delegateReason?: DelegateReason
}

/** The reviewer's structured answer, already validated and normalized. */
export interface ReviewVerdict {
  /** `allow` proceeds; `deny` refuses. */
  readonly decision: ReviewDecision
  /** One-sentence rationale shown to the user and fed back to the model. */
  readonly reason: string
  /** Reviewer's risk grade. */
  readonly risk: RiskLevel
  /** Optional actionable safer alternative (rendered on the card). */
  readonly suggestion?: string
  /** True when the reviewer declared it could not judge the action. */
  readonly uncertain: boolean
}
