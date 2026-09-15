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
}
