/**
 * Schemastery configuration for the approval-review plugin, plus the small pure
 * resolvers that turn it into effective policy. Every tunable lives here so the
 * whole behaviour is changeable from `cordis.yml` without editing code.
 * @module dsh-approval-review/config
 */

import Schema from '@deepseek-ai/schemastery'
import type { RiskLevel, ToolPolicy } from './review-types.ts'
import { RISK_LEVELS } from './review-types.ts'

/** How the plugin reacts to a reviewer verdict that exceeds the risk threshold. */
export type RiskGateAction = 'allow' | 'delegate' | 'deny'

/** How the plugin reacts when the reviewer cannot decide. */
export type UncertaintyAction = 'delegate' | 'allow' | 'deny'

/** What happens to a request the reviewer never answered (crash, timeout, bad schema). */
export type FallbackAction = 'rejected' | 'delegate' | 'allow-once'

/** What happens once the per-turn review budget is spent. */
export type BudgetAction = 'delegate' | 'deny'

/** What happens once the rejection circuit breaker trips. */
export type CircuitAction = 'delegate' | 'deny'

/** One ordered regex rule that routes a request by matching its text. */
export interface RiskRuleConfig {
  /** Regular expression source, matched against {@link field}. */
  readonly pattern: string
  /** Policy applied when the pattern matches. */
  readonly policy: ToolPolicy
  /** Which text the pattern is matched against. Defaults to the ask reason. */
  readonly field?: 'reason' | 'toolName' | 'arguments'
  /** Optional human-readable note carried into the audit record. */
  readonly note?: string
}

/** Reviewer model and prompt configuration. */
/** How the reviewer is run. */
export type ReviewerMode = 'subagent' | 'direct'

export interface ReviewerConfig {
  /** `subagent` runs a read-only child; `direct` makes one plain model call. */
  readonly mode: ReviewerMode
  /** Provider route for the reviewer; unset inherits the calling agent's provider. */
  readonly provider?: string
  /** Model id for the reviewer; unset inherits the calling agent's model. */
  readonly model?: string
  /** Subagent backend used by `mode: 'subagent'`. */
  readonly subagentProvider: string
  /**
   * The reviewer child's tool allow-list. Mutable to match Schemastery's
   * inferred `string[]`; the plugin never writes it.
   */
  readonly tools: string[]
  /** Hard deadline for one reviewer call. */
  readonly timeoutMs: number
  /** Output-token cap for one reviewer call. */
  readonly maxTokens: number
  /** Sampling temperature; the reviewer should be near-deterministic. */
  readonly temperature: number
  /** Ruling policy appended to the reviewer prompt (Codex-style policy text). */
  readonly policyText?: string
  /** Extra deployment-specific guidance appended after {@link policyText}. */
  readonly guidance?: string
  /** Max characters of one stringified argument value before it is truncated. */
  readonly argumentMaxChars: number
  /** Cross-field total argument budget in characters; 0 disables the cap. */
  readonly argumentsBudgetChars: number
}

/** Compact-transcript budget handed to the reviewer as evidence. */
export interface ContextConfig {
  /** How many prior turns of history to include; 0 sends no transcript. */
  readonly turns: number
  /** Character budget for the whole transcript section. */
  readonly maxChars: number
  /** Include assistant messages in the transcript. */
  readonly includeAssistant: boolean
  /** Include tool call/result pairs in the transcript. */
  readonly includeToolActivity: boolean
}

/** Verdict cache settings. */
export interface VerdictCacheConfig {
  /** How long a cached verdict stays usable; 0 disables the cache. */
  readonly ttlMs: number
  /** Maximum cached fingerprints before oldest-eviction. */
  readonly maxEntries: number
}

/** Per-turn reviewer budget. */
export interface BudgetConfig {
  /** Maximum reviewer calls per open turn. */
  readonly maxReviewsPerTurn: number
  /** What happens once the budget is spent. */
  readonly onExhausted: BudgetAction
}

/** Rejection circuit breaker, mirroring Codex's per-turn denial breaker. */
export interface CircuitBreakerConfig {
  /** Consecutive denials that trip the breaker. */
  readonly consecutiveDenials: number
  /** Denials within {@link windowSize} that trip the breaker; 0 disables. */
  readonly windowDenials: number
  /** Rolling window size for {@link windowDenials}. */
  readonly windowSize: number
  /** What happens once the breaker is open. */
  readonly action: CircuitAction
}

/** One-shot human override. */
export interface OverrideConfig {
  /** How long an `/approve` authorization stays usable. */
  readonly ttlMs: number
  /** How many recent denials the override selector can address. */
  readonly maxPending: number
}

/** Complete plugin configuration; every key has a schema default. */
export interface Config {
  /** Master switch: when false the plugin never claims a request. */
  readonly enabled: boolean
  /** Session-start default for the runtime `/approval-review on|off` switch. */
  readonly enabledByDefault: boolean
  /**
   * The permission preset that turns this plugin ON. Empty means "always claim",
   * which suits a deployment that has no such preset. When set, the plugin claims
   * nothing unless that preset is the session's active one — that is what makes
   * the access-mode entry the real on/off switch instead of a decorative label.
   */
  readonly reviewerPreset: string
  /** Tool-name patterns routed to the reviewer model. */
  readonly reviewTools: string[]
  /** Policy for tools matching no entry in {@link reviewTools}. */
  readonly defaultPolicy: ToolPolicy
  /** Ordered rules evaluated before the tool table. */
  readonly rules: RiskRuleConfig[]
  /** Reviewer model, prompt, and size limits. */
  readonly reviewer: ReviewerConfig
  /** Transcript evidence budget. */
  readonly context: ContextConfig
  /** Highest risk the reviewer may auto-allow. */
  readonly maxAutoAllowRisk: RiskLevel
  /** Reaction when a verdict's risk exceeds {@link maxAutoAllowRisk}. */
  readonly onRiskExceeded: RiskGateAction
  /** Reaction when the reviewer reports uncertainty. */
  readonly onUncertain: UncertaintyAction
  /** Reaction when the reviewer never answered. */
  readonly onReviewerFailure: FallbackAction
  /** Per-turn reviewer budget. */
  readonly budget: BudgetConfig
  /** Per-turn reviewer-FAILURE budget, so a broken reviewer cannot retry without bound. */
  readonly maxFailuresPerTurn: number
  /** Verdict cache settings. */
  readonly verdictCache: VerdictCacheConfig
  /** Rejection circuit breaker. */
  readonly circuitBreaker: CircuitBreakerConfig
  /** One-shot `/approve` override. */
  readonly override: OverrideConfig
  /** Character cap for any reason string this plugin emits. */
  readonly reasonMaxChars: number
  /** Append the reviewer rationale to the refused tool result the model sees. */
  readonly feedReasonToModel: boolean
  /** Language of the `/approval-review` command output. */
  readonly language: 'en' | 'zh'
}

const REVIEWER_MODES: readonly ReviewerMode[] = ['subagent', 'direct']
const TOOL_POLICIES: readonly ToolPolicy[] = ['ai', 'human', 'never']
const RISK_GATE_ACTIONS: readonly RiskGateAction[] = ['allow', 'delegate', 'deny']
const UNCERTAINTY_ACTIONS: readonly UncertaintyAction[] = ['delegate', 'allow', 'deny']
const FALLBACK_ACTIONS: readonly FallbackAction[] = ['rejected', 'delegate', 'allow-once']
const BUDGET_ACTIONS: readonly BudgetAction[] = ['delegate', 'deny']
const CIRCUIT_ACTIONS: readonly CircuitAction[] = ['delegate', 'deny']

/** Schema for {@link Config}; the loader validates against this at mount time. */
export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description(
    'Master switch. When false the plugin registers nothing that claims a request.',
  ),
  enabledByDefault: Schema.boolean().default(true).description(
    'Session-start default for the per-session switch; `/approval-review off` overrides it durably.',
  ),
  reviewerPreset: Schema.string().default('approve-for-me').description(
    'Permission preset that turns auto-approval on. Empty means always claim. Set this to the '
    + 'preset key you added to `permissionPresets` (see cordis.patch.yml).',
  ),
  reviewTools: Schema.array(Schema.string()).default(['bash', 'pwsh', 'write'])
    .description('Tool-name glob patterns routed to the reviewer model.'),
  defaultPolicy: Schema.union(TOOL_POLICIES).default('human').description(
    'Policy for tools matching no `reviewTools` pattern.',
  ),
  rules: Schema.array(Schema.object({
    pattern: Schema.string().required(),
    policy: Schema.union(TOOL_POLICIES).required(),
    field: Schema.union(['reason', 'toolName', 'arguments'] as const).default('reason'),
    note: Schema.string(),
  })).default([]).description('Ordered regex rules evaluated before the tool table.'),

  reviewer: Schema.object({
    // eslint-disable-next-line
    mode: Schema.union(REVIEWER_MODES).default('subagent').description(
      'How the reviewer runs: `subagent` forks a read-only child that can inspect the '
      + 'workspace; `direct` makes one plain model call with the evidence packet only.',
    ),
    provider: Schema.string().description('Reviewer provider route; unset inherits the calling agent.'),
    model: Schema.string().description('Reviewer model id; unset inherits the calling agent.'),
    subagentProvider: Schema.string().default('fork').description(
      'Subagent backend for `mode: subagent` (`fork` / `spawn`).',
    ),
    tools: Schema.array(Schema.string()).default(['read', 'glob', 'grep']).description(
      'The reviewer child\'s tool allow-list. An empty list falls back to the read-only default '
      + 'rather than the parent\'s whole face.',
    ),
    timeoutMs: Schema.number().step(1).min(1000).default(60000)
      .description('Hard deadline for one reviewer call.'),
    maxTokens: Schema.number().step(1).min(64).default(1024)
      .description('Output-token cap for one reviewer call (`mode: direct`).'),
    temperature: Schema.number().min(0).max(2).default(0)
      .description('Sampling temperature; 0 keeps the reviewer near-deterministic.'),
    policyText: Schema.string().description('Ruling policy appended to the reviewer prompt.'),
    guidance: Schema.string().description('Extra deployment-specific reviewer guidance.'),
    argumentMaxChars: Schema.number().step(1).min(64).default(4000)
      .description('Max characters of one stringified argument value before truncation.'),
    argumentsBudgetChars: Schema.number().step(1).min(0).default(16000)
      .description('Cross-field argument budget in characters; 0 disables the cap.'),
  // @ts-expect-error Schemastery cannot express "every field has its own default",
  // so `{}` is the correct seed even though the type demands the filled shape.
  }).default({}),

  context: Schema.object({
    turns: Schema.number().step(1).min(0).default(2)
      .description('Prior turns of transcript evidence; 0 sends none.'),
    maxChars: Schema.number().step(1).min(0).default(6000)
      .description('Character budget for the whole transcript section.'),
    includeAssistant: Schema.boolean().default(true)
      .description('Include assistant messages in the transcript.'),
    includeToolActivity: Schema.boolean().default(true)
      .description('Include tool calls and results in the transcript.'),
  // @ts-expect-error Schemastery cannot express "every field has its own default",
  // so `{}` is the correct seed even though the type demands the filled shape.
  }).default({}),

  maxAutoAllowRisk: Schema.union(RISK_LEVELS).default('medium')
    .description('Highest risk the reviewer may auto-allow.'),
  onRiskExceeded: Schema.union(RISK_GATE_ACTIONS).default('delegate')
    .description('Reaction when a verdict exceeds `maxAutoAllowRisk`.'),
  onUncertain: Schema.union(UNCERTAINTY_ACTIONS).default('delegate')
    .description('Reaction when the reviewer reports uncertainty.'),
  onReviewerFailure: Schema.union(FALLBACK_ACTIONS).default('rejected')
    .description('Reaction when the reviewer crashes, times out, or answers off-schema.'),

  budget: Schema.object({
    maxReviewsPerTurn: Schema.number().step(1).min(1).default(20)
      .description('Maximum reviewer calls per open turn.'),
    onExhausted: Schema.union(BUDGET_ACTIONS).default('delegate')
      .description('Reaction once the per-turn review budget is spent.'),
  // @ts-expect-error Schemastery cannot express "every field has its own default",
  // so `{}` is the correct seed even though the type demands the filled shape.
  }).default({}),

  maxFailuresPerTurn: Schema.number().step(1).min(1).default(10)
    .description('Maximum reviewer failures per open turn before requests delegate.'),

  verdictCache: Schema.object({
    ttlMs: Schema.number().step(1).min(0).default(60000)
      .description('Reuse a recent verdict for an identical tool+arguments fingerprint; 0 disables. '
        + 'Only consulted when `context.turns` is 0, because a transcript-dependent verdict is not '
        + 'replayable from the action alone.'),
    maxEntries: Schema.number().step(1).min(0).default(256)
      .description('Maximum cached fingerprints before oldest-eviction.'),
  // @ts-expect-error Schemastery cannot express "every field has its own default",
  // so `{}` is the correct seed even though the type demands the filled shape.
  }).default({}),

  circuitBreaker: Schema.object({
    consecutiveDenials: Schema.number().step(1).min(1).default(3)
      .description('Consecutive denials that trip the breaker.'),
    windowDenials: Schema.number().step(1).min(0).default(10)
      .description('Denials within `windowSize` that trip the breaker; 0 disables the window rule.'),
    windowSize: Schema.number().step(1).min(1).default(50)
      .description('Rolling window size for `windowDenials`.'),
    action: Schema.union(CIRCUIT_ACTIONS).default('delegate')
      .description('Reaction once the breaker is open.'),
  // @ts-expect-error Schemastery cannot express "every field has its own default",
  // so `{}` is the correct seed even though the type demands the filled shape.
  }).default({}),

  override: Schema.object({
    ttlMs: Schema.number().step(1).min(0).default(300000)
      .description('How long an `/approve` authorization stays usable.'),
    maxPending: Schema.number().step(1).min(1).default(10)
      .description('How many recent denials `/approve` can address.'),
  // @ts-expect-error Schemastery cannot express "every field has its own default",
  // so `{}` is the correct seed even though the type demands the filled shape.
  }).default({}),

  reasonMaxChars: Schema.number().step(1).min(128).default(2000)
    .description('Character cap for any reason string this plugin emits.'),
  feedReasonToModel: Schema.boolean().default(true)
    .description('Append the reviewer rationale to the refused tool result the model sees.'),
  language: Schema.union(['en', 'zh'] as const).default('en')
    .description('Language of `/approval-review` command output.'),
})

/**
 * Translate one glob-ish tool pattern into a regular expression. `*` matches any
 * run of characters; every other character is literal, so a tool name containing
 * regex metacharacters cannot accidentally widen the match.
 * @param pattern - the configured tool-name pattern.
 * @returns an anchored, case-insensitive regular expression.
 */
export function toolPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\\*/gu, '.*')
  return new RegExp(`^${escaped}$`, 'iu')
}

/** The resolved policy for one request, plus the rule that selected it. */
export interface ResolvedToolPolicy {
  /** Effective policy. */
  readonly policy: ToolPolicy
  /** Human-readable origin, carried into the audit record. */
  readonly source: string
}

/**
 * Resolve which answerer owns one request: regex rules first, then the tool
 * table, then `defaultPolicy`.
 * @param config - validated plugin configuration.
 * @param toolName - the tool the approval request is about.
 * @param reason - the asker's reason text, matched by `field: 'reason'` rules.
 * @param argumentsText - stringified tool arguments, matched by `field: 'arguments'`.
 * @returns the effective policy and its origin.
 */
export function resolveToolPolicy(
  config: Config,
  toolName: string,
  reason: string | undefined,
  argumentsText: string,
): ResolvedToolPolicy {
  for (const [index, rule] of config.rules.entries()) {
    let subject: string
    switch (rule.field ?? 'reason') {
      case 'toolName': subject = toolName; break
      case 'arguments': subject = argumentsText; break
      default: subject = reason ?? ''
    }
    let matched = false
    try {
      matched = new RegExp(rule.pattern, 'iu').test(subject)
    } catch {
      // An invalid pattern is a misconfiguration the loader could not catch
      // (regex compilation is not part of the schema); fail loud and skip it.
      throw new Error(`dsh-approval-review: rules[${index}].pattern is not a valid regular expression: ${rule.pattern}`)
    }
    if (matched) {
      return {
        policy: rule.policy,
        source: `rules[${index}] (${rule.field ?? 'reason'} =~ ${rule.pattern})${rule.note === undefined ? '' : ` — ${rule.note}`}`,
      }
    }
  }
  for (const pattern of config.reviewTools) {
    if (toolPatternToRegExp(pattern).test(toolName)) {
      return { policy: 'ai', source: `reviewTools ("${pattern}")` }
    }
  }
  return { policy: config.defaultPolicy, source: 'defaultPolicy' }
}

/**
 * Collect the pure, host-independent policy facts a decision needs. Keeping this
 * separate from the service makes every branch unit-testable without a harness.
 * @param config - validated plugin configuration.
 * @param verdict - the reviewer's answer, when it answered at all.
 * @returns the resolved gate decision and whether the human chain should decide instead.
 */
export function applyVerdictGates(
  config: Config,
  verdict: { decision: 'allow' | 'deny'; risk: RiskLevel; uncertain: boolean } | undefined,
): { readonly action: 'allow' | 'deny' | 'delegate'; readonly note: string } {
  if (verdict === undefined) {
    switch (config.onReviewerFailure) {
      case 'allow-once': return { action: 'allow', note: 'reviewer did not answer; `onReviewerFailure: allow-once`' }
      case 'delegate': return { action: 'delegate', note: 'reviewer did not answer; `onReviewerFailure: delegate`' }
      default: return { action: 'deny', note: 'reviewer did not answer; fail-closed (`onReviewerFailure: rejected`)' }
    }
  }
  if (verdict.uncertain) {
    switch (config.onUncertain) {
      case 'allow': return { action: 'allow', note: 'reviewer was uncertain; `onUncertain: allow`' }
      case 'deny': return { action: 'deny', note: 'reviewer was uncertain; `onUncertain: deny`' }
      default: return { action: 'delegate', note: 'reviewer was uncertain; delegated to the human chain' }
    }
  }
  if (verdict.decision === 'deny') {
    return { action: 'deny', note: 'reviewer denied the action' }
  }
  // An allow verdict still has to clear the deployment's risk ceiling: a
  // reviewer that is willing to allow a critical action must not silently
  // outrank the operator's stated tolerance.
  if (RISK_LEVELS.indexOf(verdict.risk) > RISK_LEVELS.indexOf(config.maxAutoAllowRisk)) {
    switch (config.onRiskExceeded) {
      case 'allow': return { action: 'allow', note: `risk ${verdict.risk} exceeds ${config.maxAutoAllowRisk}; \`onRiskExceeded: allow\`` }
      case 'deny': return { action: 'deny', note: `risk ${verdict.risk} exceeds ${config.maxAutoAllowRisk}; \`onRiskExceeded: deny\`` }
      default: return { action: 'delegate', note: `risk ${verdict.risk} exceeds ${config.maxAutoAllowRisk}; delegated to the human chain` }
    }
  }
  return { action: 'allow', note: `risk ${verdict.risk} within \`maxAutoAllowRisk\`` }
}
