/**
 * Bounded verdict cache.
 *
 * An approval loop can ask the same question repeatedly — an agent retrying one
 * command, or several agents running the same build in one workspace. The
 * reviewer costs a model call each time, so an identical `tool + arguments`
 * fingerprint reuses its recent verdict.
 *
 * **Only sound when the verdict does not depend on the conversation.** The
 * verdict is a function of the proposed action plus the evidence the reviewer
 * read; the evidence includes the transcript, which changes between turns. So
 * the cache is only consulted when `context.turns === 0` (no transcript is sent)
 * — the runtime enforces that, and a cache hit is impossible otherwise.
 * @module dsh-approval-review/verdict-cache
 */

import { createHash } from 'node:crypto'
import type { ReviewVerdict } from './review-types.ts'

/** One cached verdict plus its expiry. */
interface Entry {
  readonly verdict: ReviewVerdict
  readonly expiresAt: number
}

/** Insertion-ordered LRU with TTL expiry. */
export class VerdictCache {
  private readonly entries = new Map<string, Entry>()
  private hits = 0
  private misses = 0

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  /**
   * Whether this cache may be consulted at all.
   * @returns true when a TTL and a capacity are configured.
   */
  get enabled(): boolean {
    return this.ttlMs > 0 && this.maxEntries > 0
  }

  /**
   * Fingerprint one proposed action.
   *
   * Fields are length-prefixed rather than separator-joined: a separator can be
   * forged by field content (`("a","b\0c")` would otherwise hash like
   * `("a\0b","c")`), which would let one action reuse another's verdict. The raw
   * argument string is used verbatim — two calls are the same action only when
   * their arguments are byte-identical.
   * @param toolName - the tool being reviewed.
   * @param argumentsText - the raw argument JSON.
   * @param authorizationDigest - identity of the authorization this attempt
   *   presents (a one-shot `/approval-review approve`, when one applied). A grant
   *   exists to overturn a denial, so it belongs to the action's identity rather
   *   than beside it: keyed only on `tool + arguments`, the retry that a human
   *   just authorized would be answered from the cached copy of the denial.
   * @returns a stable hex digest.
   */
  static fingerprint(toolName: string, argumentsText: string, authorizationDigest = ''): string {
    const hash = createHash('sha256')
    for (const field of [toolName, argumentsText, authorizationDigest]) {
      hash.update(`${Buffer.byteLength(field, 'utf8')}:`)
      hash.update(field, 'utf8')
    }
    return hash.digest('hex')
  }

  /**
   * Look up a live verdict and promote it.
   * @param key - a {@link fingerprint}.
   * @param now - injectable clock for tests.
   * @returns the verdict, or undefined on a miss or expiry.
   */
  get(key: string, now = Date.now()): ReviewVerdict | undefined {
    if (!this.enabled) return undefined
    const entry = this.entries.get(key)
    if (entry === undefined) { this.misses += 1; return undefined }
    if (entry.expiresAt <= now) {
      this.entries.delete(key)
      this.misses += 1
      return undefined
    }
    // Re-insert to refresh LRU position.
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits += 1
    return entry.verdict
  }

  /**
   * Record a verdict, evicting the oldest entry past capacity.
   * @param key - a {@link fingerprint}.
   * @param verdict - the verdict to remember.
   * @param now - injectable clock for tests.
   */
  put(key: string, verdict: ReviewVerdict, now = Date.now()): void {
    if (!this.enabled) return
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, { verdict, expiresAt: now + this.ttlMs })
  }

  /** Drop every entry; counters are session-of-process statistics and survive. */
  clear(): void {
    this.entries.clear()
  }

  /** Current size, for the status report. */
  get size(): number {
    return this.entries.size
  }

  /** Cache-hit count since process start. */
  get hitCount(): number {
    return this.hits
  }

  /** Cache-miss count since process start. */
  get missCount(): number {
    return this.misses
  }
}
