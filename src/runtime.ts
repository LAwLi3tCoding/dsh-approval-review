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

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
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
  renderArguments,
  redactUnparsedText,
  renderTranscript,
  resolveReviewerRoute,
  runReviewerCall,
  type ReviewerRoute,
  type TranscriptLine,
} from './reviewer.ts'
import type { ReviewVerdict, ToolPolicy } from './review-types.ts'
import { ReviewSessions, type GuardLimits } from './review-session.ts'
import { VerdictCache } from './verdict-cache.ts'
import { runSubagentReviewer } from './subagent-reviewer.ts'
import { runJevReviewer } from './jev-reviewer.ts'
import { createInspector } from './inspection.ts'
import { resolveOutputLanguage } from './output-language.ts'
import { effectiveReviewerModel, JEV_ROUTE_PROVIDER, type ReviewerEngineName, type ReviewerIdentity } from './model-override.ts'
import { readCredentialSeam, resolveJevApiKey, type JevKeyResolution } from './jev-key.ts'

/** A refusal this plugin resolved, awaiting delivery into the refused tool result. */
export interface Refusal {
  /** The marker text appended to the tool result. */
  readonly marker: string
  /** The verdict, for logging. */
  readonly verdict?: ReviewVerdict
  /** Whether the model should be told to stop rather than retry a workaround. */
  readonly hardStop: boolean
}

/**
 * An allow verdict this plugin resolved, awaiting delivery into the accepted
 * tool result.
 *
 * A refusal rides the tool result because an approval outcome is a closed
 * vocabulary with no room for a rationale. An allow has the same problem: the
 * `approval/decided` event records `allowed-once` and nothing else, so without
 * this carrier the ledger can show that an action ran but never why it was
 * allowed. The marker is the same one refusals use, so the fold parses both
 * through one inverse.
 */
export interface Allowance {
  /** The marker text appended to the tool result. */
  readonly marker: string
  /** The verdict, for logging. */
  readonly verdict?: ReviewVerdict
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
  private readonly pendingStops = new WeakMap<Session, { agent: Agent; callId: string }>()
  /** Refusals by callId, consumed by the `tools/post-execute` listener. */
  private readonly refusals = new Map<string, Refusal>()
  /** Allow verdicts by callId, consumed by the `tools/post-execute` listener. */
  private readonly allowances = new Map<string, Allowance>()
  /**
   * Session ids of reviewer children currently in flight. A reviewer child must
   * never be reviewed by the answerer it is serving: with `read`/`glob`/`grep`
   * alone it raises no approval, but a deployment that widens `reviewer.tools`
   * would otherwise let the reviewer's own escalations recurse into this
   * answerer. Populated when the child is established (before it can ask) and
   * cleared when its run settles.
   */
  private readonly reviewerSessions = new Set<string>()
  /** Latest folded audit state per session, for the live view defaults. */
  private readonly auditStates = new WeakMap<Session, AuditState>()
  /** Sessions whose committed log has already been replayed into that fold. */
  private readonly replayed = new WeakSet<Session>()
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

  /**
   * Whether a verdict is replayable from the action's own bytes.
   *
   * The Jev engine never inspects local state (one HTTP call, no tools), so it
   * qualifies regardless of the `mode` / `inspectLocalState` keys — both of
   * which belong to the LLM engine. Without this branch, enabling the cache on a
   * Jev deployment would silently never reuse anything, because
   * `inspectLocalState` defaults to true.
   */
  private verdictReplayableFor(engine: ReviewerEngineName): boolean {
    if (engine === 'jev') return true
    return this.config.reviewer.mode === 'direct' && !this.config.reviewer.inspectLocalState
  }

  /**
   * Whether the cache may be consulted for one session's engine: no transcript
   * means the verdict is replayable, and a Jev verdict always is.
   * @param engine - the engine that will answer this session.
   * @returns true when a cached verdict may be reused.
   */
  private cacheUsableFor(engine: ReviewerEngineName): boolean {
    return this.config.context.turns === 0 && this.verdictReplayableFor(engine) && this.cache.enabled
  }

  /** Cache usability under the DEPLOYMENT engine, for the status report. */
  private get cacheUsable(): boolean {
    return this.cacheUsableFor(this.config.reviewer.engine)
  }

  /**
   * The reviewer identity in force for one session.
   *
   * One place decides how a recorded override meets the engine in force; see
   * `model-override.ts` for why an LLM-shaped override must not be forwarded to
   * Jev. Everything that needs the effective model — routing, the audit marker,
   * the card — reads it from here.
   * @param session - the session being reviewed for.
   * @returns the provider label, the model id, and any discarded override.
   */
  reviewerIdentityFor(session: Session): ReviewerIdentity {
    const state = this.auditStates.get(session)
    return effectiveReviewerModel({
      engine: this.config.reviewer.engine,
      ...state?.engineOverride === undefined ? {} : { overrideEngine: state.engineOverride },
      ...state?.providerOverride === undefined ? {} : { overrideProvider: state.providerOverride },
      ...state?.modelOverride === undefined ? {} : { overrideModel: state.modelOverride },
      defaultProvider: this.reviewerProviderLabel,
      defaultModel: this.reviewerModelLabel,
      jevPermitted: this.config.reviewer.jev.allowEgress,
    })
  }

  /**
   * The reviewer model actually in force for one session: the durable
   * `/approval-review model <id>` override when it fits the engine, else the
   * deployment default.
   * @param session - the session being reviewed for.
   * @returns the model id, or undefined to inherit the session's own model.
   */
  reviewerModelFor(session: Session): string | undefined {
    const model = this.reviewerIdentityFor(session).model
    return model.length === 0 ? undefined : model
  }

  /**
   * The reviewer provider in force for one session. Only the LLM engine routes by
   * provider; the Jev engine's route is synthesized from its endpoint.
   * @param session - the session being reviewed for.
   * @returns the provider id, or undefined to inherit.
   */
  reviewerProviderFor(session: Session): string | undefined {
    if (this.config.reviewer.engine === 'jev') return undefined
    const provider = this.reviewerIdentityFor(session).provider
    return provider.length === 0 ? undefined : provider
  }

  /**
   * The Jev model in force for one session.
   * @param session - the session being reviewed for.
   * @returns the Jev model name or alias to send.
   */
  jevModelFor(session: Session): string {
    return this.reviewerIdentityFor(session).model
  }

  /**
   * Resolve the Jev API key for one review.
   *
   * The credential seam comes first so that a key stored through DSH's own
   * credential UI — or in `$DSH_HOME/.env`, or exported before launch — works for
   * every installer, and rotation applies to the next verdict without a restart.
   * Reading `process.env` directly stays as the fallback for a deployment that
   * does not mount the credentials row.
   * @returns the key and its provenance; never throws.
   */
  private async resolveJevKey(): Promise<JevKeyResolution> {
    return await resolveJevApiKey({
      envName: this.config.reviewer.jev.apiKeyEnv,
      seam: readCredentialSeam(this.ctx.get('credentials')),
      env: process.env,
    })
  }

  /** Provider half of the reviewer route the card and status report show. */
  private get reviewerProviderLabel(): string {
    return this.config.reviewer.engine === 'jev' ? 'typesafe' : this.config.reviewer.provider ?? ''
  }

  /** Model half of the reviewer route the card and status report show. */
  private get reviewerModelLabel(): string {
    return this.config.reviewer.engine === 'jev' ? this.config.reviewer.jev.model : this.config.reviewer.model ?? ''
  }

  /** Reviewer failures recorded in the open turn, for the status report. */
  failuresThisTurn(session: Session): number {
    return this.sessions.failuresThisTurn(session)
  }

  /**
   * Why requests were handed to the human chain in the open turn, most frequent
   * first, for the status report.
   * @param session - the session to report on.
   * @returns one `code×count` label per distinct reason.
   */
  delegationsThisTurn(session: Session): readonly string[] {
    return this.sessions.delegations(session)
  }

  /**
   * Hand one request to the rest of the answerer chain, recording WHY.
   *
   * A ledger row that carries no rationale means "this plugin did not decide", and
   * the reason matters: `no-call-id` means the action could not be read at all
   * (the request event carries no arguments), while `access-mode` means the
   * operator's own switch kept the plugin out. Counting them makes
   * `/approval-review status` the answer instead of a guess.
   * @param session - the requesting session.
   * @param code - short machine-readable reason code.
   * @param next - the rest of the chain.
   * @returns the chain's own outcome.
   */
  private async handOff(session: Session, code: string, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    this.sessions.noteDelegation(session, code)
    return await next()
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
    const stop = this.pendingStops.get(session)
    if (stop !== undefined && event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'tool-result' && block.toolCallId === stop.callId)) {
      this.pendingStops.delete(session)
      // The refusal is durable before cancelling the turn; preserve queued user input.
      stop.agent.cancel({ kind: 'hook', reason: 'approval reviewer rejection circuit breaker' }, { keepInbox: true })
    }
    if (event.type === 'turn/start') this.pendingStops.delete(session)
    this.sessions.observe(session, event)
    if (!this.replayed.has(session)) {
      this.replayed.add(session)
      // Replay the committed log ONCE, the first time this session is seen.
      //
      // The incremental fold below only ever sees events from mount onward, so
      // a durable `/approval-review on|off` or `model …` issued in a PREVIOUS
      // process lifetime was invisible to the runtime: after a desktop restart
      // the plugin silently fell back to inheriting the calling agent's model
      // instead of honouring the operator's choice. The session PROJECtion
      // replays the log, so the tab and the behaviour disagreed — the tab showed
      // the chosen route while reviews ran on the inherited one.
      //
      // The event that triggered this call is already committed, so the replay
      // covers it and no separate fold is applied.
      let state = initAuditState()
      for (let seq = 0; seq < session.seq; seq += 1) {
        const committed = session.eventAt(seq as never)
        if (committed !== undefined) state = applyAuditEvent(state, committed, this.config)
      }
      this.auditStates.set(session, state)
      return
    }
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
      defaultReviewerModel: this.reviewerModelLabel,
      defaultReviewerProvider: this.reviewerProviderLabel,
      defaultReviewerEngine: this.config.reviewer.engine,
      defaultJevPermitted: this.config.reviewer.jev.allowEgress,
      resolvePolicy: (toolName, reason, argumentsText) => this.resolvePolicy(toolName, reason, argumentsText),
    })
  }

  /**
   * Re-derive the routing policy of one request from the deployment config. The
   * fold runs this so an `approval/asked` row states the policy that actually
   * routed it instead of claiming every request was reviewed.
   *
   * It NEVER throws, unlike the decision path: `resolveToolPolicy` fails loud on
   * an invalid rule pattern, and a throwing projection `apply` would take down
   * the whole fold for the session — the card would go blank because of a
   * misconfigured regex. The decision path keeps the loud failure where an
   * operator can see it.
   * @param toolName - the tool the request is about.
   * @param reason - the asker's reason, matched by `field: 'reason'` rules.
   * @param argumentsText - the argument text, matched by `field: 'arguments'` rules.
   * @returns the effective policy and the rule that selected it.
   */
  resolvePolicy(
    toolName: string,
    reason: string | undefined,
    argumentsText: string,
  ): { readonly policy: ToolPolicy; readonly source: string } {
    try {
      const resolved = resolveToolPolicy(this.config, toolName, reason, argumentsText)
      return { policy: resolved.policy, source: resolved.source }
    } catch (error: unknown) {
      return {
        policy: this.config.defaultPolicy,
        source: `unresolved (${error instanceof Error ? error.message : String(error)})`,
      }
    }
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
        defaultReviewerModel: this.reviewerModelLabel,
        defaultReviewerProvider: this.reviewerProviderLabel,
        defaultReviewerEngine: this.config.reviewer.engine,
        defaultJevPermitted: this.config.reviewer.jev.allowEgress,
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
  recordOverride(session: Session, override: { toolName: string; at: number; reviewId?: string; callId?: string }): boolean {
    const raw = this.argumentsFor(session, override.callId)
    if (raw.length === 0) return false
    this.sessions.addOverride(session, {
      ...override, fingerprint: VerdictCache.fingerprint(override.toolName, raw),
    }, this.limits)
    return true
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
    if (!this.config.enabled) return await this.handOff(session, 'plugin-disabled', next)
    if (!this.isEnabled(session)) return await this.handOff(session, 'session-off', next)
    // The reviewer's own child session is never reviewed: a widened
    // `reviewer.tools` must not let the reviewer's asks recurse into the
    // answerer that is serving it.
    if (this.isReviewerSession(session)) return await this.handOff(session, 'reviewer-session', next)
    if (!this.presetAllows(session)) return await this.handOff(session, 'access-mode', next)

    const rawArguments = this.argumentsFor(session, req.callId)
    // Policy rules match the RAW arguments: a rule that denies a call containing
    // a literal credential must still see it. Everything the reviewer sees is
    // redacted separately, below.
    const resolved = resolveToolPolicy(this.config, req.toolName, req.reason, rawArguments)

    switch (resolved.policy) {
      case 'human':
        return await this.handOff(session, 'policy-human', next)
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
      // Without a call id the proposed action cannot be read — the request event
      // carries no arguments, so the call id is the only handle on the action —
      // and there is no evidence to review. Delegating keeps a human in the loop.
      return await this.handOff(session, 'no-call-id', next)
    }

    const override = this.sessions.consumeOverride(session, req.toolName, this.limits, VerdictCache.fingerprint(req.toolName, rawArguments))
    if (this.sessions.circuitOpen(session, this.limits) && override === undefined) {
      if (this.config.circuitBreaker.action === 'stop') {
        req.agent.cancel({ kind: 'hook', reason: 'approval reviewer rejection circuit breaker' }, { keepInbox: true })
        return 'rejected'
      }
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
      return await this.handOff(session, 'circuit', next)
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
      return await this.handOff(session, 'budget', next)
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
    // The session's `/approval-review model <id>` override outranks the
    // deployment default in BOTH reviewer modes. Resolving it into the route
    // here — rather than only in the subagent dispatch below — is what keeps
    // `mode: direct` from silently ignoring the command.
    //
    // The session's reviewer selection may have switched engines (picking an LLM
    // route under a Jev deployment, or the reverse), so everything below reads the
    // EFFECTIVE engine, never the deployment's `reviewer.engine`.
    const identity = this.reviewerIdentityFor(session)
    // The Jev engine has no LLM route to inherit: its route is the TypeSafe
    // endpoint plus the Jev model, and it must be synthesized BEFORE the no-route
    // guard below. Otherwise a Jev deployment whose agent has no provider or model
    // would delegate every request and never call Jev at all.
    const route: ReviewerRoute | undefined = identity.engine === 'jev'
      ? { provider: JEV_ROUTE_PROVIDER, model: identity.model.length > 0 ? identity.model : this.config.reviewer.jev.model }
      : resolveReviewerRoute(
        {
          provider: identity.provider.length > 0 ? identity.provider : undefined,
          model: identity.model.length > 0 ? identity.model : undefined,
        },
        {
          provider: req.agent.options.provider,
          model: req.agent.options.model,
        },
      )
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
    // Never approve a truncated command whose hidden suffix may change its effect.
    try {
      if (!rawArguments || argumentsText !== renderArguments(JSON.parse(rawArguments), Number.MAX_SAFE_INTEGER, 0)) {
        return await this.delegate(req, 'incomplete-action-evidence', next)
      }
    } catch {
      return await this.delegate(req, 'invalid-action-evidence', next)
    }
    const transcript = this.buildTranscript(session)
    const userIntent = this.buildUserIntent(session)

    // Reuse a recent verdict for a byte-identical action. Only sound with no
    // transcript in evidence, because otherwise the verdict also depends on the
    // conversation and could not be replayed from the action alone.
    const fingerprint = VerdictCache.fingerprint(session.id, JSON.stringify([req.toolName, rawArguments, req.reason, userIntent, route]))
    if (this.cacheUsableFor(identity.engine) && override === undefined) {
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
    // Resolved per review, exactly like the command output: a language switch
    // reaches the NEXT verdict. Prose already recorded is never rewritten.
    const outputLanguage = resolveOutputLanguage(this.ctx, this.config)
    // One key resolution per review: the credential seam re-reads its sources, so
    // a rotated key reaches the next verdict without a restart. The key itself is
    // never logged — only where it came from.
    const jevKey = identity.engine === 'jev' ? await this.resolveJevKey() : undefined
    if (jevKey !== undefined) {
      const log = this.ctx.logger('dsh-approval-review')
      if (jevKey.source === 'none') {
        log.warn(`no Jev API key: ${this.config.reviewer.jev.apiKeyEnv} is unset in the credential store and in the environment`)
      } else {
        log.debug(`Jev API key resolved from ${jevKey.source}${jevKey.detail === undefined ? '' : ` (${jevKey.detail})`}`)
      }
      const rejected = this.reviewerIdentityFor(session).rejectedOverride
      if (rejected !== undefined) {
        log.warn(`the session reviewer override "${rejected}" does not fit the Jev engine, which sends a bare model name; `
          + `using ${this.config.reviewer.jev.model} instead`)
      }
    }
    const result = identity.engine === 'jev'
      ? await runJevReviewer({
        endpoint: this.config.reviewer.jev.endpoint,
        // The resolved route carries the session override, so `/approval-review
        // model <jev id>` works exactly as it does on the LLM path.
        model: route.model,
        credential: jevKey?.key,
        apiKeyEnv: this.config.reviewer.jev.apiKeyEnv,
        timeoutMs: this.config.reviewer.jev.timeoutMs,
        permitProbMin: this.config.reviewer.jev.permitProbMin,
        prohibitedAt: this.config.reviewer.jev.prohibitedAt,
        scopeBoundedAt: this.config.reviewer.jev.scopeBoundedAt,
        rubric: this.config.reviewer.jev.rubric,
        evidence: {
          toolName: req.toolName,
          argumentsText,
          transcript,
          userIntent,
          ...req.reason === undefined ? {} : { askReason: req.reason },
        },
        outputLanguage,
        exactActionApproval: override !== undefined,
        ...req.signal === undefined ? {} : { signal: req.signal },
      })
      : this.config.reviewer.mode === 'subagent'
      ? await runSubagentReviewer(this.ctx, {
        ...this.reviewerProviderFor(session) === undefined ? {} : { provider: this.reviewerProviderFor(session)! },
        ...this.reviewerModelFor(session) === undefined ? {} : { model: this.reviewerModelFor(session)! },
        reviewerProvider: this.config.reviewer.subagentProvider,
        reviewerTools: this.config.reviewer.tools,
        timeoutMs: this.config.reviewer.timeoutMs,
        parent: req.agent,
        // The child is registered as soon as it exists, so its own approval
        // asks (a widened `reviewer.tools`) can never reach this answerer.
        registerChildSession: childSessionId => this.registerReviewerSession(childSessionId),
        evidence: {
          toolName: req.toolName,
          argumentsText,
          transcript,
          userIntent,
          ...req.reason === undefined ? {} : { askReason: req.reason },
        },
        ...this.config.reviewer.policyText === undefined ? {} : { policyText: this.config.reviewer.policyText },
        ...this.config.reviewer.guidance === undefined ? {} : { guidance: this.config.reviewer.guidance },
        outputLanguage,
        exactActionApproval: override !== undefined,
        ...req.signal === undefined ? {} : { signal: req.signal },
      })
      : await runReviewerCall(
        this.ctx,
        route,
        buildReviewerSystemPrompt({
          ...this.config.reviewer.policyText === undefined ? {} : { policyText: this.config.reviewer.policyText },
          ...this.config.reviewer.guidance === undefined ? {} : { guidance: this.config.reviewer.guidance },
          outputLanguage,
          exactActionApproval: override !== undefined,
        }),
        buildReviewerUserMessage({
          toolName: req.toolName,
          argumentsText,
          transcript,
          userIntent,
          ...req.reason === undefined ? {} : { askReason: req.reason },
        }),
        {
          ...this.config.reviewer.maxTokens === undefined ? {} : { maxTokens: this.config.reviewer.maxTokens },
          temperature: this.config.reviewer.temperature,
          timeoutMs: this.config.reviewer.timeoutMs,
          ...req.signal === undefined ? {} : { signal: req.signal },
          sessionId: session.id,
          ...!this.config.reviewer.inspectLocalState || session.header.cwd === undefined ? {} : { inspect: createInspector(session.header.cwd, rawArguments, redactUnparsedText) },
        },
      )
    if (result.verdict === undefined) this.sessions.noteFailure(session)
    else if (this.cacheUsableFor(identity.engine) && override === undefined) this.cache.put(fingerprint, result.verdict)

    // Name the version that actually answered when the engine reports one: a
    // Jev alias (`jev-latest`) resolves server-side, and thresholds tuned
    // against one version must stay traceable to it in the ledger.
    const routeLabel = result.answeredModel === undefined
      ? `${route.provider}/${route.model}`
      : `${route.provider}/${result.answeredModel}`

    return await this.settle(req, session, policySource, route, result.verdict, result.durationMs, override, next, result.failure, routeLabel)
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
   * @param routeLabel - `provider/model` to record; defaults to the resolved route.
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
    routeLabel?: string,
  ): Promise<ApprovalOutcome> {
    const callId = req.callId
    /* v8 ignore next -- callers reject callId-less requests before reaching here */
    if (callId === undefined) return await next()
    const reviewerRoute = routeLabel ?? `${route.provider}/${route.model}`

    if (req.signal?.aborted === true) return 'cancelled'
    const gate = applyVerdictGates(this.config, verdict)
    if (gate.action === 'delegate') {
      this.ctx.logger('dsh-approval-review').info(
        `delegating tool "${req.toolName}" to the human chain: ${gate.note}${failure === undefined ? '' : ` (${failure})`}`,
      )
      return await this.delegate(req, verdict === undefined ? 'reviewer-failure' : gate.note, next)
    }

    if (gate.action === 'allow') {
      this.recordDecision(session, false)
      // The allow verdict gets the same durable carrier a refusal does, for the
      // same reason: `approval/decided` records the outcome and nothing else, so
      // this marker is the only place the rationale can survive into the log.
      if (this.config.recordAllowedVerdicts) {
        this.putAllowance(callId, {
          marker: formatReviewMarker({
            reason: verdict?.reason ?? gate.note,
            ...verdict?.suggestion === undefined ? {} : { suggestion: verdict.suggestion },
            ...verdict?.risk === undefined ? {} : { risk: verdict.risk },
        ...verdict?.userAuthorization === undefined ? {} : { userAuthorization: verdict.userAuthorization },
        overridden: override !== undefined,
            // A route is only meaningful when a reviewer actually answered.
            ...verdict === undefined ? {} : { reviewerRoute },
            durationMs,
            uncertain: verdict?.uncertain === true,
          }),
          ...verdict === undefined ? {} : { verdict },
        })
      }
      this.ctx.logger('dsh-approval-review').info(
        `allowed ${req.toolName} (${policySource}): ${verdict?.reason ?? gate.note}`,
      )
      return 'allowed-once'
    }

    this.putRefusal(callId, {
      marker: formatReviewMarker({
        // A reviewer that never answered must say WHY. `gate.note` only names
        // the policy; the failure detail is what turns "the reviewer did not
        // answer" into an actionable line (a rejected credential, a provider
        // 404, a timeout). It was log-only, which made an unusable reviewer
        // route indistinguishable from a decisive refusal.
        reason: clampReason(
          verdict === undefined ? (failure === undefined ? gate.note : `${gate.note} — ${failure}`)
            : verdict.decision === 'allow' ? `${gate.note}: ${verdict.reason}` : verdict.reason,
          this.config.reasonMaxChars,
        ),
        ...verdict?.suggestion === undefined ? {} : { suggestion: verdict.suggestion },
        ...verdict?.risk === undefined ? {} : { risk: verdict.risk },
        ...verdict?.userAuthorization === undefined ? {} : { userAuthorization: verdict.userAuthorization },
        overridden: override !== undefined,
        reviewerRoute,
        durationMs,
        uncertain: verdict?.uncertain === true,
      }),
      ...verdict === undefined ? {} : { verdict },
      hardStop: true,
    })
    this.recordDecision(session, true)
    if (this.config.circuitBreaker.action === 'stop' && this.sessions.circuitOpen(session, this.limits)) {
      this.pendingStops.set(session, { agent: req.agent, callId })
    }
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
    code?: string,
  ): Promise<ApprovalOutcome> {
    // Record WHY, for the status report: the short codes this path passes through
    // are kept verbatim, while the gate's prose notes collapse to `gate`.
    this.sessions.noteDelegation(req.agent.session, code ?? (/\s/u.test(reason) ? 'gate' : reason))
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

  /** Stash the allow marker for the post-execute listener. */
  private putAllowance(callId: string, allowance: Allowance): void {
    this.allowances.set(callId, allowance)
    if (this.allowances.size > 512) {
      const oldest = this.allowances.keys().next()
      if (!oldest.done) this.allowances.delete(oldest.value)
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

  /**
   * Take the allow verdict stashed for one call.
   * @param callId - the call identity.
   * @returns the allowance, removed from the map.
   */
  takeAllowance(callId: string): Allowance | undefined {
    const allowance = this.allowances.get(callId)
    if (allowance !== undefined) this.allowances.delete(callId)
    return allowance
  }

  /**
   * Whether a session belongs to this plugin's own reviewer dispatch.
   * @param session - the session raising the approval request.
   * @returns true when the request comes from a reviewer child in flight.
   */
  isReviewerSession(session: Session): boolean {
    return this.reviewerSessions.has(String(session.header.id))
  }

  /**
   * Register a reviewer child whose asks must never be reviewed by this
   * answerer. Called as soon as the child session exists — before its first step
   * can raise an approval — and released when its run settles.
   * @param sessionId - the child session id.
   * @returns the release function; idempotent.
   */
  registerReviewerSession(sessionId: string): () => void {
    this.reviewerSessions.add(sessionId)
    return () => { this.reviewerSessions.delete(sessionId) }
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

  /** Keep original intent and latest real user constraints independently of tool noise. */
  buildUserIntent(session: Session): string {
    const messages: string[] = []
    for (let seq = 0; seq < session.seq; seq += 1) {
      const event = session.eventAt(seq as never)
      if (event?.type !== 'user/message' || event.data.source?.kind !== 'user') continue
      const text = blocksToText(event.data.content)
      if (text) messages.push(text)
    }
    if (messages.length === 0) return ''
    // Reserve the first request plus the latest requests/corrections. JSON
    // encoding prevents message contents from forging evidence role boundaries.
    const selected = messages.length <= 5 ? messages : [messages[0]!, ...messages.slice(-4)]
    return JSON.stringify({ source: session.header.origin === 'subagent' ? 'delegated agent task; not direct human authorization' : 'host user messages', omittedMessages: messages.length - selected.length,
      messages: selected.map(text => text.length <= 3000 ? text : `${text.slice(0, 1500)}\n[message middle omitted]\n${text.slice(-1500)}`) })
  }

  /** Render one event into a transcript line, or skip it. */
  private transcriptLine(event: SessionEvent): TranscriptLine | undefined {
    switch (event.type) {
      case 'user/message': {
        const text = blocksToText(event.data.content)
        return text.length === 0 ? undefined : { role: event.data.source?.kind === 'user' ? 'user' : 'tool', text }
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

/**
 * Bound a reason the plugin is about to publish.
 *
 * The marker rides the tool result, which is model context, so `reasonMaxChars`
 * has to hold here rather than only in the config schema. This is also what
 * keeps a provider's multi-line error digest from swallowing the guidance that
 * follows it.
 * @param reason - the assembled reason.
 * @param max - configured cap.
 * @returns the reason, truncated with an ellipsis when it exceeds the cap.
 */
export function clampReason(reason: string, max: number): string {
  if (reason.length <= max) return reason
  return `${reason.slice(0, Math.max(0, max - 1))}…`
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
