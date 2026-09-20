/**
 * Guard tests: the per-turn budget, the rejection circuit breaker, and the
 * one-shot override. These are the only behavioural limits that live outside the
 * durable log, so their edges are pinned explicitly.
 * @module dsh-approval-review/tests/review-session
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { ReviewSessions, type GuardLimits } from '../src/review-session.ts'

/** A distinct WeakMap key per test; the guards read no session state. */
function session(): Session {
  return { id: 's' } as unknown as Session
}

function limits(overrides: Partial<GuardLimits> = {}): GuardLimits {
  return {
    maxReviewsPerTurn: 20,
    maxFailuresPerTurn: 10,
    consecutiveDenials: 3,
    windowDenials: 10,
    windowSize: 50,
    maxPending: 10,
    overrideTtlMs: 300000,
    ...overrides,
  }
}

/** Advance a session into `turn`. */
function enterTurn(sessions: ReviewSessions, target: Session, turn: number): void {
  sessions.observe(target, { type: 'turn/start', data: { turn } })
}

describe('ReviewSessions delegations', () => {
  it('counts reason codes, most frequent first', () => {
    const sessions = new ReviewSessions()
    const target = session()
    sessions.noteDelegation(target, 'no-call-id')
    sessions.noteDelegation(target, 'no-call-id')
    sessions.noteDelegation(target, 'access-mode')
    expect(sessions.delegations(target)).toEqual(['no-call-id×2', 'access-mode×1'])
  })

  it('starts empty and clears when the turn rolls over', () => {
    const sessions = new ReviewSessions()
    const target = session()
    expect(sessions.delegations(target)).toEqual([])
    sessions.noteDelegation(target, 'no-call-id')
    enterTurn(sessions, target, 1)
    expect(sessions.delegations(target)).toEqual([])
  })
})

describe('ReviewSessions budget', () => {
  it('allows reviews until the budget is spent', () => {
    const sessions = new ReviewSessions()
    const target = session()
    enterTurn(sessions, target, 1)
    const guard = limits({ maxReviewsPerTurn: 2 })
    expect(sessions.budgetAvailable(target, guard)).toBe(true)
    sessions.noteReview(target)
    expect(sessions.budgetAvailable(target, guard)).toBe(true)
    sessions.noteReview(target)
    expect(sessions.budgetAvailable(target, guard)).toBe(false)
  })

  it('refills the budget on the next turn', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ maxReviewsPerTurn: 1 })
    enterTurn(sessions, target, 1)
    sessions.noteReview(target)
    expect(sessions.budgetAvailable(target, guard)).toBe(false)
    enterTurn(sessions, target, 2)
    expect(sessions.budgetAvailable(target, guard)).toBe(true)
  })

  it('tracks failures separately from reviews', () => {
    const sessions = new ReviewSessions()
    const target = session()
    enterTurn(sessions, target, 1)
    sessions.noteReview(target)
    sessions.noteFailure(target)
    expect(sessions.stateOf(target).reviewsThisTurn).toBe(1)
    expect(sessions.stateOf(target).failuresThisTurn).toBe(1)
  })
})

describe('ReviewSessions circuit breaker', () => {
  it('stays closed below the consecutive threshold', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ consecutiveDenials: 3 })
    enterTurn(sessions, target, 1)
    sessions.noteDecision(target, true, guard)
    sessions.noteDecision(target, true, guard)
    expect(sessions.circuitOpen(target, guard)).toBe(false)
  })

  it('opens at the consecutive threshold', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ consecutiveDenials: 3 })
    enterTurn(sessions, target, 1)
    for (let index = 0; index < 3; index += 1) sessions.noteDecision(target, true, guard)
    expect(sessions.circuitOpen(target, guard)).toBe(true)
  })

  it('resets the consecutive counter on an allowance', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ consecutiveDenials: 3 })
    enterTurn(sessions, target, 1)
    sessions.noteDecision(target, true, guard)
    sessions.noteDecision(target, true, guard)
    sessions.noteDecision(target, false, guard)
    expect(sessions.stateOf(target).denialsStreak).toBe(0)
    expect(sessions.circuitOpen(target, guard)).toBe(false)
  })

  it('opens on the rolling window rule even without a streak', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ consecutiveDenials: 99, windowDenials: 3, windowSize: 10 })
    enterTurn(sessions, target, 1)
    // Alternate so the consecutive counter never reaches its own threshold.
    sessions.noteDecision(target, true, guard)
    sessions.noteDecision(target, false, guard)
    sessions.noteDecision(target, true, guard)
    sessions.noteDecision(target, false, guard)
    expect(sessions.circuitOpen(target, guard)).toBe(false)
    sessions.noteDecision(target, true, guard)
    expect(sessions.circuitOpen(target, guard)).toBe(true)
  })

  it('keeps the window bounded', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ windowDenials: 0, windowSize: 4 })
    enterTurn(sessions, target, 1)
    for (let index = 0; index < 10; index += 1) sessions.noteDecision(target, true, guard)
    expect(sessions.stateOf(target).window).toHaveLength(4)
  })

  it('disables the window rule at zero', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ consecutiveDenials: 99, windowDenials: 0 })
    enterTurn(sessions, target, 1)
    for (let index = 0; index < 20; index += 1) sessions.noteDecision(target, true, guard)
    expect(sessions.circuitOpen(target, guard)).toBe(false)
  })

  it('re-closes the breaker on a new turn', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ consecutiveDenials: 2 })
    enterTurn(sessions, target, 1)
    sessions.noteDecision(target, true, guard)
    sessions.noteDecision(target, true, guard)
    expect(sessions.circuitOpen(target, guard)).toBe(true)
    enterTurn(sessions, target, 2)
    expect(sessions.circuitOpen(target, guard)).toBe(false)
  })

  it('latches the trip for the rest of the turn even after an allowance', () => {
    // Once tripped, the turn is meant to stop escalating; an intervening grant
    // must not silently re-open the reviewer.
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ consecutiveDenials: 2 })
    enterTurn(sessions, target, 1)
    sessions.noteDecision(target, true, guard)
    sessions.noteDecision(target, true, guard)
    expect(sessions.circuitOpen(target, guard)).toBe(true)
    sessions.noteDecision(target, false, guard)
    expect(sessions.circuitOpen(target, guard)).toBe(true)
  })
})

describe('ReviewSessions overrides', () => {
  it('consumes the newest matching authorization for a tool', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits()
    sessions.addOverride(target, { toolName: 'bash', fingerprint: 'exact', at: Date.now(), reviewId: 'r1' }, guard)
    sessions.addOverride(target, { toolName: 'bash', fingerprint: 'exact', at: Date.now(), reviewId: 'r2' }, guard)
    expect(sessions.consumeOverride(target, 'bash', guard, 'exact')?.reviewId).toBe('r2')
    expect(sessions.consumeOverride(target, 'bash', guard, 'exact')?.reviewId).toBe('r1')
    expect(sessions.consumeOverride(target, 'bash', guard, 'exact')).toBeUndefined()
  })

  it('leaves an authorization for another tool alone', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits()
    sessions.addOverride(target, { toolName: 'write', fingerprint: 'exact', at: Date.now() }, guard)
    expect(sessions.consumeOverride(target, 'bash', guard, 'exact')).toBeUndefined()
    expect(sessions.liveOverrides(target, guard)).toHaveLength(1)
  })

  it('expires an authorization past its TTL', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ overrideTtlMs: 10 })
    sessions.addOverride(target, { toolName: 'bash', fingerprint: 'exact', at: Date.now() - 1000 }, guard)
    expect(sessions.liveOverrides(target, guard)).toHaveLength(0)
    expect(sessions.consumeOverride(target, 'bash', guard, 'exact')).toBeUndefined()
  })

  it('keeps an authorization forever at a zero TTL', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ overrideTtlMs: 0 })
    sessions.addOverride(target, { toolName: 'bash', fingerprint: 'exact', at: 0 }, guard)
    expect(sessions.liveOverrides(target, guard)).toHaveLength(1)
  })

  it('bounds the pending list', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ maxPending: 2 })
    for (let index = 0; index < 5; index += 1) {
      sessions.addOverride(target, { toolName: 'bash', fingerprint: 'exact', at: Date.now(), reviewId: `r${index}` }, guard)
    }
    expect(sessions.liveOverrides(target, guard)).toHaveLength(2)
  })

  it('drops expired entries when a new one is recorded', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ overrideTtlMs: 10 })
    sessions.addOverride(target, { toolName: 'bash', fingerprint: 'exact', at: Date.now() - 1000 }, guard)
    sessions.addOverride(target, { toolName: 'bash', fingerprint: 'exact', at: Date.now() }, guard)
    expect(sessions.liveOverrides(target, guard)).toHaveLength(1)
  })
})

describe('ReviewSessions snapshot', () => {
  it('reports the live counters the card shows', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ consecutiveDenials: 2 })
    enterTurn(sessions, target, 1)
    sessions.noteDecision(target, true, guard)
    const snapshot = sessions.snapshot(target, guard)
    expect(snapshot.consecutiveDenials).toBe(1)
    expect(snapshot.circuitOpen).toBe(false)
    expect(snapshot.pendingOverrides).toBe(0)
  })

  it('reports an open circuit without mutating the latch', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ consecutiveDenials: 1 })
    enterTurn(sessions, target, 1)
    sessions.noteDecision(target, true, guard)
    expect(sessions.snapshot(target, guard).circuitOpen).toBe(true)
    enterTurn(sessions, target, 2)
    expect(sessions.snapshot(target, guard).circuitOpen).toBe(false)
  })

  it('isolates two sessions', () => {
    const sessions = new ReviewSessions()
    const first = session()
    const second = session()
    const guard = limits()
    enterTurn(sessions, first, 1)
    enterTurn(sessions, second, 1)
    sessions.noteReview(first)
    expect(sessions.stateOf(first).reviewsThisTurn).toBe(1)
    expect(sessions.stateOf(second).reviewsThisTurn).toBe(0)
  })
})

describe('ReviewSessions failure budget', () => {
  it('allows attempts until the failure budget is spent', () => {
    const sessions = new ReviewSessions()
    const target = session()
    enterTurn(sessions, target, 1)
    const guard = limits({ maxFailuresPerTurn: 2 })
    expect(sessions.failureBudgetAvailable(target, guard)).toBe(true)
    sessions.noteFailure(target)
    sessions.noteFailure(target)
    expect(sessions.failureBudgetAvailable(target, guard)).toBe(false)
    expect(sessions.failuresThisTurn(target)).toBe(2)
  })

  it('refills the failure budget on the next turn', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ maxFailuresPerTurn: 1 })
    enterTurn(sessions, target, 1)
    sessions.noteFailure(target)
    expect(sessions.failureBudgetAvailable(target, guard)).toBe(false)
    enterTurn(sessions, target, 2)
    expect(sessions.failureBudgetAvailable(target, guard)).toBe(true)
    expect(sessions.failuresThisTurn(target)).toBe(0)
  })

  it('keeps the review and failure budgets independent', () => {
    const sessions = new ReviewSessions()
    const target = session()
    const guard = limits({ maxReviewsPerTurn: 5, maxFailuresPerTurn: 1 })
    enterTurn(sessions, target, 1)
    sessions.noteReview(target)
    sessions.noteFailure(target)
    expect(sessions.budgetAvailable(target, guard)).toBe(true)
    expect(sessions.failureBudgetAvailable(target, guard)).toBe(false)
  })
})
