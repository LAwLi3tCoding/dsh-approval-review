/**
 * The approval-review answerer: the host half that decides one `approval/request`
 * with a second model, feeds its rationale back to the calling model, and keeps
 * the audit ledger's live counters.
 *
 * Position in the chain matters. The listener is registered with
 * `prepend: true` so the plugin sits AHEAD of the human answerer a UI provides,
 * and it claims only the requests its own policy routes to `ai`. Everything else
 * is delegated with `next()`, so installing this plugin can never silently
 * remove a human from a decision it was not configured to take over.
 * @module dsh-approval-review/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  applyVerdictGates,
  resolveToolPolicy,
  type Config,
} from './config.ts'
import {
  applyAuditEvent,
  auditView,
  createAuditProjection,
  type AuditProjectionKey,
  type WiredProjectionDefinition,
  formatReviewMarker,
  initAuditState,
  type AuditState,
  type AuditView,
} from './audit.ts'
import {
  buildReviewerSystemPrompt,
  buildReviewerUserMessage,
  redactToolArguments,
  renderTranscript,
  resolveReviewerRoute,
  runReviewerCall,
  type ReviewerRoute,
  type TranscriptLine,
} from './reviewer.ts'
import type { ReviewVerdict } from './review-types.ts'
import { ReviewSessions, type GuardLimits } from './review-session.ts'
import { VerdictCache } from './verdict-cache.ts'
import { runSubagentReviewer } from './subagent-reviewer.ts'

/** A refusal this plugin resolved, awaiting delivery into the refused tool result. */
export interface Refusal {
  /** The marker text appended to the tool result. */
  readonly marker: string
  /** The verdict, for logging. */
  readonly verdict?: ReviewVerdict
  /** Whether the model should be told to stop rather than retry a workaround. */
  readonly hardStop: boolean
}

/** Build the guard limits the runtime consults. */
export function guardLimits(config: Config): GuardLimits {
  return {
    maxReviewsPerTurn: config.budget.maxReviewsPerTurn,
    maxFailuresPerTurn: config.maxFailuresPerTurn,
    consecutiveDenials: config.circuitBreaker.consecutiveDenials,
    windowDenials: config.circuitBreaker.windowDenials,
    windowSize: config.circuitBreaker.windowSize,
    maxPending: config.override.maxPending,
    overrideTtlMs: config.override.ttlMs,
  }
}

/**
 * The review runtime. One instance per plugin mount; holds the per-session
 * counters and the refusals awaiting delivery.
 */
export class ReviewRuntime {
  private readonly sessions = new ReviewSessions()
  /** Refusals by callId, consumed by the `tools/post-execute` listener. */
  private readonly refusals = new Map<string, Refusal>()
  /** Latest folded audit state per session, for the live view defaults. */
  private readonly auditStates = new WeakMap<Session, AuditState>()
  /** Reused verdicts for identical actions, when the evidence allows it. */
  readonly cache: VerdictCache

  /** Number of verdicts served from the cache since mount. */
  private cacheHits = 0

  constructor(
    private readonly ctx: Context,
    public readonly config: Config,
  ) {
    this.cache = new VerdictCache(config.verdictCache.ttlMs, config.verdictCache.maxEntries)
  }

  /** Whether the cache may be consulted: no transcript means the verdict is replayable. */
  private get cacheUsable(): boolean {
    return this.config.context.turns === 0 && this.cache.enabled
  }

  /**
   * The reviewer model actually in force for one session: the durable
   * `/approval-review model <id>` override when set, else the deployment default.
   * @param session - the session being reviewed for.
   * @returns the model id, or undefined to inherit the session's own model.
   */
  reviewerModelFor(session: Session): string | undefined {
    const override = this.auditStates.get(session)?.modelOverride
    const chosen = override ?? this.config.reviewer.model
    return chosen === undefined || chosen.length === 0 ? undefined : chosen
  }

  /** Reviewer failures recorded in the open turn, for the status report. */
  failuresThisTurn(session: Session): number {
    return this.sessions.failuresThisTurn(session)
  }

  /** Cache statistics for the status report. */
  stats(): { readonly hits: number; readonly misses: number; readonly size: number; readonly usable: boolean } {
    return { hits: this.cacheHits, misses: this.cache.missCount, size: this.cache.size, usable: this.cacheUsable }
  }

  /** Effective guard limits for this mount. */
  get limits(): GuardLimits {
    return guardLimits(this.config)
  }

  /**
   * Track committed events so the runtime's turn boundary matches the ledger's.
   * @param session - the session the event belongs to.
   * @param event - the committed event.
   */
  observeEvent(session: Session, event: SessionEvent): void {
    this.sessions.observe(session, event)
    const previous = this.auditStates.get(session) ?? initAuditState()
    this.auditStates.set(session, applyAuditEvent(previous, event, this.config))
  }

  /**
   * Whether auto-review is switched on for one session. The durable
   * `command/run` fold wins over the deployment default.
   * @param session - the session to test.
   * @returns true when requests may be claimed.
   */
  isEnabled(session: Session): boolean {
    const state = this.auditStates.get(session)
    return state?.enabledOverride ?? this.config.enabledByDefault
  }

  /** The projection definition for the audit card, closed over this mount's defaults. */
  projection(): WiredProjectionDefinition<AuditProjectionKey> {
    const breaker = (denialsStreak: number, window: readonly boolean[]): boolean =>
      denialsStreak >= this.config.circuitBreaker.consecutiveDenials
      || (this.config.circuitBreaker.windowDenials > 0
        && window.filter(Boolean).length >= this.config.circuitBreaker.windowDenials)
    return createAuditProjection({
      enabledByDefault: this.config.enabledByDefault,
      maxReviewsPerTurn: this.config.budget.maxReviewsPerTurn,
      breakerTrips: state => breaker(state.denialsStreak, state.window),
      defaultReviewerModel: this.config.reviewer.model ?? '',
    })
  }

  /** Snapshot the live counters the card overlays on the folded ledger. */
  liveView(session: Session): AuditView {
    const state = this.auditStates.get(session) ?? initAuditState()
    const live = this.sessions.snapshot(session, this.limits)
    return {
      ...auditView(state, {
        enabledByDefault: this.config.enabledByDefault,
        maxReviewsPerTurn: this.config.budget.maxReviewsPerTurn,
        breakerTrips: live.circuitOpen,
        defaultReviewerModel: this.config.reviewer.model ?? '',
      }),
      consecutiveDenials: live.consecutiveDenials,
      pendingOverrides: live.pendingOverrides,
      circuitOpen: live.circuitOpen,
    }
  }

  /**
   * Record a one-shot `/approve` authorization.
   * @param session - the session the authorization belongs to.
   * @param override - the authorization to record.
   */
  recordOverride(session: Session, override: { toolName: string; at: number; reviewId?: string }): void {
    this.sessions.addOverride(session, override, this.limits)
  }


  /**
   * Whether the session's ACTIVE access-mode preset is the one that turns this
   * plugin on.
   *
   * This is what makes the access-mode entry a real switch rather than a label:
   * the plugin refuses to claim any request while the session sits on a different
   * preset, so picking "工作区内修改" restores the ordinary human prompt even
   * though both presets carry the same (sandbox, approval) knobs.
   * @param session - the session whose active preset is read.
   * @returns true when this plugin may claim requests.
   */
  private presetAllows(session: Session): boolean {
    if (this.config.reviewerPreset.length === 0) return true
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return true
    const snapshot = registry.snapshot(session)
    // Read structurally: the `permissions` unit belongs to another package, and
    // this plugin must build without depending on its type outlet.
    const permissions = (snapshot.values as Record<string, unknown>)['permissions'] as
      | { readonly currentValue?: unknown }
      | undefined
    const current = permissions?.currentValue
    // No projection yet (first step of a session) is not evidence of a mismatch;
    // the recorded selection lands before any approval can be raised.
    if (typeof current !== 'string') return true
    return current === this.config.reviewerPreset
  }

  /**
   * Decide one approval request. Every branch resolves; nothing throws out of
   * this method, because a throwing answerer would fail the whole question
   * closed and lose the audit record with it.
   * @param req - the pending approval request from the seam.
   * @param next - the rest of the answerer chain.
   * @returns the closed approval outcome.
   */
  async answer(
    req: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const session = req.agent.session
    if (!this.config.enabled) return await next()
    if (!this.isEnabled(session)) return await next()
    if (!this.presetAllows(session)) return await next()

    const rawArguments = this.argumentsFor(session, req.callId)
    // Policy rules match the RAW arguments: a rule that denies a call containing
    // a literal credential must still see it. Everything the reviewer sees is
    // redacted separately, below.
    const resolved = resolveToolPolicy(this.config, req.toolName, req.reason, rawArguments)

    switch (resolved.policy) {
      case 'human':
        return await next()
      case 'never':
        // The hard-disable stance: refuse deterministically, with a rationale the
        // model can read, and never consult a model or a human.
        if (req.callId !== undefined) {
          this.putRefusal(req.callId, {
            marker: formatReviewMarker({
              reason: `tool "${req.toolName}" is configured with policy "never"; this action class is refused without review`,
              risk: 'high',
            }),
            hardStop: true,
          })
        }
        this.recordDecision(session, true)
        return 'rejected'
      default:
        break
    }

    if (req.callId === undefined) {
      // Without a call id the proposed action cannot be read, so there is no
      // evidence to review. Delegating keeps a human in the loop.
      return await next()
    }

    const override = this.sessions.consumeOverride(session, req.toolName, this.limits)
    if (this.sessions.circuitOpen(session, this.limits) && override === undefined) {
      if (this.config.circuitBreaker.action === 'deny') {
        this.putRefusal(req.callId, {
          marker: formatReviewMarker({
            reason: 'the rejection circuit breaker is open for this turn; the agent has been refused repeatedly and must stop rather than retry',
            risk: 'high',
            uncertain: true,
          }),
          hardStop: true,
        })
        this.recordDecision(session, true)
        return 'rejected'
      }
      return await next()
    }
    if (!this.sessions.budgetAvailable(session, this.limits)) {
      if (this.config.budget.onExhausted === 'deny') {
        this.putRefusal(req.callId, {
          marker: formatReviewMarker({
            reason: 'the per-turn automatic review budget is exhausted; refusing rather than reviewing again this turn',
            risk: 'medium',
            uncertain: true,
          }),
          hardStop: true,
        })
        this.recordDecision(session, true)
        return 'rejected'
      }
      return await next()
    }

    return await this.review(req, session, resolved.source, rawArguments, override, next)
  }

  /**
   * Run the reviewer and translate its verdict into an approval outcome.
   * @param req - the approval request.
   * @param session - the requesting session.
   * @param policySource - which rule routed this request.
   * @param rawArguments - the call's arguments, redacted before they reach the reviewer.
   * @param override - the consumed one-shot authorization, when one applied.
   * @returns the closed approval outcome.
   */
  private async review(
    req: ApprovalRequestEvent,
    session: Session,
    policySource: string,
    rawArguments: string,
    override: { toolName: string; reviewId?: string } | undefined,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const callId = req.callId
    /* v8 ignore next -- callers reject callId-less requests before reaching here */
    if (callId === undefined) return await next()
    const route = resolveReviewerRoute(this.config.reviewer, {
      provider: req.agent.options.provider,
      model: req.agent.options.model,
    })
    if (route === undefined) {
      // No route means no reviewer; the human chain is the only safe owner.
      this.ctx.logger('dsh-approval-review').warn(
        `no reviewer route for tool "${req.toolName}" (agent has no provider/model and reviewer.provider/model are unset); delegating`,
      )
      return await this.delegate(req, 'no-route', next)
    }

    // The reviewer is a second model and gets only redacted arguments; the audit
    // ledger keeps the raw ones, which already sit in the user's log.
    const argumentsText = redactToolArguments(
      rawArguments,
      this.config.reviewer.argumentMaxChars,
      this.config.reviewer.argumentsBudgetChars,
    )
    const transcript = this.buildTranscript(session)

    // Reuse a recent verdict for a byte-identical action. Only sound with no
    // transcript in evidence, because otherwise the verdict also depends on the
    // conversation and could not be replayed from the action alone.
    const fingerprint = VerdictCache.fingerprint(req.toolName, rawArguments)
    if (this.cacheUsable) {
      const cached = this.cache.get(fingerprint)
      if (cached !== undefined) {
        this.cacheHits += 1
        this.ctx.logger('dsh-approval-review').debug(
          `reused a cached verdict for tool "${req.toolName}"`,
        )
        return await this.settle(req, session, policySource, route, cached, 0, override, next)
      }
    }

    if (!this.sessions.failureBudgetAvailable(session, this.limits)) {
      this.ctx.logger('dsh-approval-review').warn(
        `reviewer failed too often this turn (${this.sessions.failuresThisTurn(session)}); leaving tool "${req.toolName}" to the composed answerers`,
      )
      return await this.delegate(req, 'reviewer-failure', next)
    }

    this.sessions.noteReview(session)
    const result = this.config.reviewer.mode === 'subagent'
      ? await runSubagentReviewer(this.ctx, {
        ...this.config.reviewer.provider === undefined ? {} : { provider: this.config.reviewer.provider },
        ...this.reviewerModelFor(session) === undefined ? {} : { model: this.reviewerModelFor(session)! },
        reviewerProvider: this.config.reviewer.subagentProvider,
        reviewerTools: this.config.reviewer.tools,
        timeoutMs: this.config.reviewer.timeoutMs,
        parent: req.agent,
        evidence: {
          toolName: req.toolName,
          argumentsText,
          transcript,
          ...req.reason === undefined ? {} : { askReason: req.reason },
        },
        ...this.config.reviewer.policyText === undefined ? {} : { policyText: this.config.reviewer.policyText },
        ...this.config.reviewer.guidance === undefined ? {} : { guidance: this.config.reviewer.guidance },
        ...req.signal === undefined ? {} : { signal: req.signal },
      })
      : await runReviewerCall(
        this.ctx,
        route,
        buildReviewerSystemPrompt(this.config.reviewer),
        buildReviewerUserMessage({
          toolName: req.toolName,
          argumentsText,
          transcript,
          ...req.reason === undefined ? {} : { askReason: req.reason },
        }),
        {
          maxTokens: this.config.reviewer.maxTokens,
          temperature: this.config.reviewer.temperature,
          timeoutMs: this.config.reviewer.timeoutMs,
          ...req.signal === undefined ? {} : { signal: req.signal },
          sessionId: session.id,
        },
      )
    if (result.verdict === undefined) this.sessions.noteFailure(session)
    else if (this.cacheUsable) this.cache.put(fingerprint, result.verdict)

    return await this.settle(req, session, policySource, route, result.verdict, result.durationMs, override, next, result.failure)
  }

  /**
   * Turn one reviewer verdict (or its absence) into an approval outcome: apply
   * the risk/uncertainty gates, fold the breaker, stash the refusal marker.
   * @param req - the approval request.
   * @param session - the requesting session.
   * @param policySource - which rule routed this request, for the log line.
   * @param route - the route the reviewer ran on.
   * @param verdict - the verdict, or undefined when the reviewer never answered.
   * @param durationMs - reviewer duration for the audit marker.
   * @param override - the consumed one-shot authorization, when one applied.
   * @param next - the rest of the answerer chain.
   * @param failure - the reviewer's failure description, when it never answered.
   * @returns the closed approval outcome.
   */
  private async settle(
    req: ApprovalRequestEvent,
    session: Session,
    policySource: string,
    route: ReviewerRoute,
    verdict: ReviewVerdict | undefined,
    durationMs: number,
    override: { toolName: string; reviewId?: string } | undefined,
    next: () => Promise<ApprovalOutcome>,
    failure?: string,
  ): Promise<ApprovalOutcome> {
    const callId = req.callId
    /* v8 ignore next -- callers reject callId-less requests before reaching here */
    if (callId === undefined) return await next()

    const gate = applyVerdictGates(this.config, verdict)
    if (gate.action === 'delegate') {
      this.ctx.logger('dsh-approval-review').info(
        `delegating tool "${req.toolName}" to the human chain: ${gate.note}${failure === undefined ? '' : ` (${failure})`}`,
      )
      return await this.delegate(req, verdict === undefined ? 'reviewer-failure' : 'uncertain', next)
    }

    if (gate.action === 'allow') {
      this.recordDecision(session, false)
      this.ctx.logger('dsh-approval-review').info(
        `allowed ${req.toolName} (${policySource}): ${verdict?.reason ?? gate.note}`,
      )
      return 'allowed-once'
    }

    this.putRefusal(callId, {
      marker: formatReviewMarker({
        reason: verdict?.reason ?? gate.note,
        ...verdict?.suggestion === undefined ? {} : { suggestion: verdict.suggestion },
        ...verdict?.risk === undefined ? {} : { risk: verdict.risk },
        reviewerRoute: `${route.provider}/${route.model}`,
        durationMs,
        uncertain: verdict?.uncertain === true,
      }),
      ...verdict === undefined ? {} : { verdict },
      hardStop: true,
    })
    this.recordDecision(session, true)
    this.ctx.logger('dsh-approval-review').info(
      `refused ${req.toolName} (${policySource}): ${verdict?.reason ?? gate.note}`,
    )
    if (override !== undefined) {
      this.ctx.logger('dsh-approval-review').info(
        `a one-shot override was presented for tool "${req.toolName}" but the reviewer still refused`,
      )
    }
    return 'rejected'
  }

  /**
   * Hand a request to the rest of the answerer chain.
   * @param req - the approval request (already known to precede `next`).
   * @param reason - why this plugin did not decide, for the operator log.
   * @param next - the rest of the chain.
   * @returns the chain's own outcome.
   */
  private async delegate(
    req: ApprovalRequestEvent,
    reason: string,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    this.ctx.logger('dsh-approval-review').debug(
      `left tool "${req.toolName}" to the composed answerers (${reason})`,
    )
    return await next()
  }
  /** Fold one decision into the breaker counters. */
  private recordDecision(session: Session, refused: boolean): void {
    this.sessions.noteDecision(session, refused, this.limits)
  }

  /** Stash the refusal marker for the post-execute listener. */
  private putRefusal(callId: string, refusal: Refusal): void {
    this.refusals.set(callId, refusal)
    // Bound the map: a refusal is consumed within the same step, so a modest cap
    // only ever discards entries whose tool call never materialized.
    if (this.refusals.size > 512) {
      const oldest = this.refusals.keys().next()
      if (!oldest.done) this.refusals.delete(oldest.value)
    }
  }

  /**
   * Take the refusal stashed for one call.
   * @param callId - the call identity.
   * @returns the refusal, removed from the map.
   */
  takeRefusal(callId: string): Refusal | undefined {
    const refusal = this.refusals.get(callId)
    if (refusal !== undefined) this.refusals.delete(callId)
    return refusal
  }

  /** Read the raw argument JSON of a tool call from the session log. */
  private argumentsFor(session: Session, callId: string | undefined): string {
    if (callId === undefined) return ''
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq as never)
      if (event?.type === 'tool/call' && event.data.callId === callId) return event.data.arguments
    }
    return ''
  }

  /**
   * Build the bounded transcript evidence for one session, covering the current
   * turn plus the configured number of prior turns.
   * @param session - the session to read.
   * @returns rendered transcript lines, oldest first.
   */
  buildTranscript(session: Session): string {
    if (this.config.context.turns <= 0 || this.config.context.maxChars <= 0) return ''
    const boundaries: number[] = []
    for (let seq = 0; seq < session.seq; seq += 1) {
      if (session.eventAt(seq as never)?.type === 'turn/start') boundaries.push(seq)
    }
    const wanted = boundaries.slice(-(this.config.context.turns + 1))
    if (wanted.length === 0) return ''
    const lines: TranscriptLine[] = []
    for (let seq = wanted[0]!; seq < session.seq; seq += 1) {
      const event = session.eventAt(seq as never)
      if (event === undefined) continue
      const line = this.transcriptLine(event)
      if (line !== undefined) lines.push(line)
    }
    return renderTranscript(lines, this.config.context.maxChars)
  }

  /** Render one event into a transcript line, or skip it. */
  private transcriptLine(event: SessionEvent): TranscriptLine | undefined {
    switch (event.type) {
      case 'user/message': {
        const text = blocksToText(event.data.content)
        return text.length === 0 ? undefined : { role: 'user', text }
      }
      case 'assistant/message': {
        if (!this.config.context.includeAssistant) return undefined
        const text = blocksToText(event.data.message.content)
        return text.length === 0 ? undefined : { role: 'assistant', text }
      }
      case 'tool/call': {
        if (!this.config.context.includeToolActivity) return undefined
        // The transcript reads the same `tool/call` event as the proposed-action
        // section, so it must pass through the SAME redaction. Building it from
        // the raw argument string would hand the reviewer exactly the credentials
        // the proposed-action section just masked.
        const preview = redactToolArguments(
          event.data.arguments,
          this.config.reviewer.argumentMaxChars,
          this.config.reviewer.argumentsBudgetChars,
        )
        return { role: 'tool', text: `called ${event.data.name} with ${preview}` }
      }
      case 'tool/result': {
        if (!this.config.context.includeToolActivity) return undefined
        const text = blocksToText(event.data.message.content)
        return text.length === 0 ? undefined : { role: 'tool', text: `result: ${text}` }
      }
      default:
        return undefined
    }
  }
}

/** Join the text of a content-block list, walking nested tool-result blocks. */
export function blocksToText(blocks: readonly ContentBlock[]): string {
  const out: string[] = []
  const walk = (list: readonly ContentBlock[]): void => {
    for (const block of list) {
      if (block.type === 'text') out.push(block.text)
      else if (block.type === 'tool-result') walk(block.content)
    }
  }
  walk(blocks)
  return out.join('\n')
}

/**
 * Whether an agent belongs to this plugin's own reviewer dispatch. The reviewer
 * is a plain model call rather than an agent, so no live agent carries this
 * marker today; the check keeps a future agent-based reviewer from recursing
 * into the answerer it is serving.
 * @param agent - the agent to test.
 * @returns true when the agent is the reviewer.
 */
export function isReviewerAgent(agent: Agent): boolean {
  // A reviewer agent, if one is ever introduced, announces itself through the
  // delegation label the subagent seam records on the child session header.
  const header = agent.session.header as { title?: unknown } | undefined
  return typeof header?.title === 'string' && header.title.startsWith('approval-review:')
}
