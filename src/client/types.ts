/**
 * Wire-safe view of one audit entry, mirroring the host's `AuditRecord`. Declared
 * locally so the browser half needs no host type packages to compile.
 * @module dsh-approval-review/client/types
 */

/** How one approval request was resolved. */
export type ClientOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Risk grade a reviewer reported. */
export type ClientRisk = 'low' | 'medium' | 'high' | 'critical'

/** One audit entry as the review card renders it. */
export interface ClientAuditRecord {
  readonly reviewId: string
  readonly seq: number
  readonly toolName: string
  readonly callId?: string
  readonly turn: number
  readonly step: number
  readonly startedAt: number
  readonly policy: 'ai' | 'human' | 'never'
  readonly policySource: string
  readonly askReason?: string
  readonly argumentsPreview?: string
  readonly outcome?: ClientOutcome
  readonly reason?: string
  readonly suggestion?: string
  readonly userAuthorization?: 'high' | 'medium' | 'low' | 'unknown'
  readonly risk?: ClientRisk
  readonly reviewerRoute?: string
  readonly durationMs?: number
  readonly refused: boolean
  readonly uncertain: boolean
  readonly overridden: boolean
}

/** The `approvalReview` projection value. */
export interface ClientAuditView {
  readonly records: readonly ClientAuditRecord[]
  readonly enabled: boolean
  readonly reviewsThisTurn: number
  readonly maxReviewsPerTurn: number
  readonly consecutiveDenials: number
  readonly circuitOpen: boolean
  readonly total: number
  readonly refused: number
  readonly pendingOverrides: number
  /** Reviewer model in force for this session; `''` means inherit the session model. */
  readonly reviewerModel: string
  /** Provider half of the effective reviewer route; `''` means the inherited one. */
  readonly reviewerProvider: string
  /**
   * Engine that answers IN THIS SESSION: the deployment's choice, unless a
   * selection from the picker switched it. Absent on an older host, which this
   * client reads as `llm`.
   */
  readonly reviewerEngine?: 'llm' | 'jev'
  /**
   * Whether the picker may offer Jev models at all — the deployment acknowledged
   * that evidence leaves the machine. This is not engine-dependent: choosing a Jev
   * row is exactly how a session switches to Jev.
   */
  readonly jevSelectable?: boolean
}
