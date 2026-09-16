import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
import "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-session-projection";
//#region src/review-types.d.ts
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
type ToolPolicy = 'ai' | 'human' | 'never';
/** Risk grades a reviewer may report, ordered from least to most dangerous. */
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type UserAuthorization = 'high' | 'medium' | 'low' | 'unknown';
//#endregion
//#region src/config.d.ts
/** How the plugin reacts to a reviewer verdict that exceeds the risk threshold. */
type RiskGateAction = 'allow' | 'delegate' | 'deny';
/** How the plugin reacts when the reviewer cannot decide. */
type UncertaintyAction = 'delegate' | 'allow' | 'deny';
/** What happens to a request the reviewer never answered (crash, timeout, bad schema). */
type FallbackAction = 'rejected' | 'delegate' | 'allow-once';
/** What happens once the per-turn review budget is spent. */
type BudgetAction = 'delegate' | 'deny';
/** What happens once the rejection circuit breaker trips. */
type CircuitAction = 'delegate' | 'deny' | 'stop';
/** One ordered regex rule that routes a request by matching its text. */
interface RiskRuleConfig {
  /** Regular expression source, matched against {@link field}. */
  readonly pattern: string;
  /** Policy applied when the pattern matches. */
  readonly policy: ToolPolicy;
  /** Which text the pattern is matched against. Defaults to the ask reason. */
  readonly field?: 'reason' | 'toolName' | 'arguments';
  /** Optional human-readable note carried into the audit record. */
  readonly note?: string;
}
/** Reviewer model and prompt configuration. */
/** How the reviewer is run. */
type ReviewerMode = 'subagent' | 'direct';
interface ReviewerConfig {
  /** `subagent` runs a read-only child; `direct` makes one plain model call. */
  readonly mode: ReviewerMode;
  /** Provider route for the reviewer; unset inherits the calling agent's provider. */
  readonly provider?: string;
  /** Model id for the reviewer; unset inherits the calling agent's model. */
  readonly model?: string;
  /** Subagent backend used by `mode: 'subagent'`. */
  readonly subagentProvider: string;
  /** Isolated read-only local inspection, with a fixed four-call budget. */
  readonly inspectLocalState: boolean;
  /**
   * The reviewer child's tool allow-list. Mutable to match Schemastery's
   * inferred `string[]`; the plugin never writes it.
   */
  readonly tools: string[];
  /** Hard deadline for one reviewer call. */
  readonly timeoutMs: number;
  /** Output-token cap for one reviewer call. */
  readonly maxTokens: number;
  /** Sampling temperature; the reviewer should be near-deterministic. */
  readonly temperature: number;
  /** Ruling policy appended to the reviewer prompt (Codex-style policy text). */
  readonly policyText?: string;
  /** Extra deployment-specific guidance appended after {@link policyText}. */
  readonly guidance?: string;
  /** Max characters of one stringified argument value before it is truncated. */
  readonly argumentMaxChars: number;
  /** Cross-field total argument budget in characters; 0 disables the cap. */
  readonly argumentsBudgetChars: number;
}
/** Compact-transcript budget handed to the reviewer as evidence. */
interface ContextConfig {
  /** How many prior turns of history to include; 0 sends no transcript. */
  readonly turns: number;
  /** Character budget for the whole transcript section. */
  readonly maxChars: number;
  /** Include assistant messages in the transcript. */
  readonly includeAssistant: boolean;
  /** Include tool call/result pairs in the transcript. */
  readonly includeToolActivity: boolean;
}
/** Verdict cache settings. */
interface VerdictCacheConfig {
  /** How long a cached verdict stays usable; 0 disables the cache. */
  readonly ttlMs: number;
  /** Maximum cached fingerprints before oldest-eviction. */
  readonly maxEntries: number;
}
/** Per-turn reviewer budget. */
interface BudgetConfig {
  /** Maximum reviewer calls per open turn. */
  readonly maxReviewsPerTurn: number;
  /** What happens once the budget is spent. */
  readonly onExhausted: BudgetAction;
}
/** Rejection circuit breaker, mirroring Codex's per-turn denial breaker. */
interface CircuitBreakerConfig {
  /** Consecutive denials that trip the breaker. */
  readonly consecutiveDenials: number;
  /** Denials within {@link windowSize} that trip the breaker; 0 disables. */
  readonly windowDenials: number;
  /** Rolling window size for {@link windowDenials}. */
  readonly windowSize: number;
  /** What happens once the breaker is open. */
  readonly action: CircuitAction;
}
/** One-shot human override. */
interface OverrideConfig {
  /** How long an `/approve` authorization stays usable. */
  readonly ttlMs: number;
  /** How many recent denials the override selector can address. */
  readonly maxPending: number;
}
/** Complete plugin configuration; every key has a schema default. */
interface Config {
  /** Master switch: when false the plugin never claims a request. */
  readonly enabled: boolean;
  /** Session-start default for the runtime `/approval-review on|off` switch. */
  readonly enabledByDefault: boolean;
  /**
   * The permission preset that turns this plugin ON. Empty means "always claim",
   * which suits a deployment that has no such preset. When set, the plugin claims
   * nothing unless that preset is the session's active one — that is what makes
   * the access-mode entry the real on/off switch instead of a decorative label.
   */
  readonly reviewerPreset: string;
  /** Tool-name patterns routed to the reviewer model. */
  readonly reviewTools: string[];
  /** Policy for tools matching no entry in {@link reviewTools}. */
  readonly defaultPolicy: ToolPolicy;
  /** Ordered rules evaluated before the tool table. */
  readonly rules: RiskRuleConfig[];
  /** Reviewer model, prompt, and size limits. */
  readonly reviewer: ReviewerConfig;
  /** Transcript evidence budget. */
  readonly context: ContextConfig;
  /** Highest risk the reviewer may auto-allow. */
  readonly maxAutoAllowRisk: RiskLevel;
  /** Reaction when a verdict's risk exceeds {@link maxAutoAllowRisk}. */
  readonly onRiskExceeded: RiskGateAction;
  /** Reaction when the reviewer reports uncertainty. */
  readonly onUncertain: UncertaintyAction;
  /** Reaction when the reviewer never answered. */
  readonly onReviewerFailure: FallbackAction;
  /** Per-turn reviewer budget. */
  readonly budget: BudgetConfig;
  /** Per-turn reviewer-FAILURE budget, so a broken reviewer cannot retry without bound. */
  readonly maxFailuresPerTurn: number;
  /** Verdict cache settings. */
  readonly verdictCache: VerdictCacheConfig;
  /** Rejection circuit breaker. */
  readonly circuitBreaker: CircuitBreakerConfig;
  /** One-shot `/approve` override. */
  readonly override: OverrideConfig;
  /** Character cap for any reason string this plugin emits. */
  readonly reasonMaxChars: number;
  /** Append the reviewer rationale to the refused tool result the model sees. */
  readonly feedReasonToModel: boolean;
  /**
   * Append the reviewer's ALLOW verdict to the accepted tool result.
   *
   * A refusal already carries its rationale into the tool result, which is the
   * only channel this plugin can write durably without inventing a session event
   * type. An allow verdict has no such carrier, so without this the audit ledger
   * can show THAT an action was allowed but never WHY. Turning it on costs one
   * marker block (four short lines) in the model's context per auto-allowed
   * call; turning it off leaves allowed rows rationale-less in the card.
   */
  readonly recordAllowedVerdicts: boolean;
  /**
   * Language of every piece of prose this plugin EMITS: the `/approval-review`
   * command output and the reviewer's own `reason`/`suggestion` fields.
   *
   * `auto` (the default) follows the harness's own language preference —
   * `设置 → 通用 → 语言`, the `locale` settings namespace — and is resolved at
   * each call, so a switch applies to the next command and the next verdict
   * without a restart. An explicit `en`/`zh` pins it regardless of that setting.
   *
   * What it never touches: the wire enums (`allow`/`deny`, `low`/…), which the
   * parser validates as English tokens, and text already RECORDED in the session
   * log. A verdict's prose is part of the transcript the model reads, so it is
   * frozen at decision time and is never retroactively translated.
   */
  readonly language: 'auto' | 'en' | 'zh';
}
/** Schema for {@link Config}; the loader validates against this at mount time. */
declare const Config: Schema<Config>;
//#endregion
//#region src/audit.d.ts
/** One rendered audit entry. Every field is plain JSON. */
interface AuditRecord {
  /** Fresh id minted when the request was reviewed. */
  readonly reviewId: string;
  /** Session-unique sequence for stable ordering in the card. */
  readonly seq: number;
  /** Tool the request was about. */
  readonly toolName: string;
  /** The exact tool call, when the asker supplied one. */
  readonly callId?: string;
  /** Turn the request arrived in. */
  readonly turn: number;
  /** Step the request arrived in. */
  readonly step: number;
  /** Epoch milliseconds when the request was accepted for review. */
  readonly startedAt: number;
  /** Effective tool policy at decision time. */
  readonly policy: 'ai' | 'human' | 'never';
  /** Which rule selected that policy. */
  readonly policySource: string;
  /** The asker's own reason for requesting approval. */
  readonly askReason?: string;
  /** Redaction-free arguments preview (already in the user's own log). */
  readonly argumentsPreview?: string;
  /** How the request was finally resolved, from the host's own decision event. */
  readonly outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
  /** The reviewer's rationale, folded out of the refused tool result. */
  readonly reason?: string;
  /** Actionable safer alternative the reviewer suggested. */
  readonly suggestion?: string;
  /** Risk grade the reviewer reported. */
  readonly userAuthorization?: UserAuthorization;
  readonly risk?: RiskLevel;
  /** Reviewer route, when it is recorded in the refusal marker. */
  readonly reviewerRoute?: string;
  /** Reviewer duration in milliseconds. */
  readonly durationMs?: number;
  /** Convenience verdict for the card's tone: did this end in a refusal? */
  readonly refused: boolean;
  /** True when the reviewer was uncertain rather than decisive. */
  readonly uncertain: boolean;
  /** True when a one-shot `/approve` override authorized the retry. */
  readonly overridden: boolean;
}
/** Client-visible projection value: the ledger for one session. */
interface AuditView {
  /** Newest-first audit entries. */
  readonly records: readonly AuditRecord[];
  /** Effective auto-review switch (`enabledByDefault` already applied). */
  readonly enabled: boolean;
  /** Reviewer calls already spent in the open turn. */
  readonly reviewsThisTurn: number;
  /** Per-turn reviewer budget in force. */
  readonly maxReviewsPerTurn: number;
  /** Consecutive denials, counting the open turn. */
  readonly consecutiveDenials: number;
  /** Whether the rejection circuit breaker is currently open. */
  readonly circuitOpen: boolean;
  /** Cumulative reviewed-request count for the session. */
  readonly total: number;
  /** Successful refuse count for the session (compact and plain, not a delta). */
  readonly refused: number;
  /** One-shot overrides still usable. */
  readonly pendingOverrides: number;
  /**
   * The reviewer model actually in force for this session: the durable override
   * when one was set, else the deployment default (`''` = inherit the session
   * model).
   */
  readonly reviewerModel: string;
  /**
   * Provider half of the effective reviewer route (`''` = the deployment
   * default, which itself falls back to the calling agent's provider).
   */
  readonly reviewerProvider: string;
}
/** Raw projection state; the wire view is derived from it. */
interface AuditState {
  readonly records: readonly AuditRecord[];
  /** In-flight approvals by `approval/asked` id, settled by `approval/decided`. */
  readonly pending: Readonly<Record<string, AuditRecord>>;
  /** `tool/call` arguments by callId, for the preview. */
  readonly arguments: Readonly<Record<string, string>>;
  readonly turn: number;
  readonly step: number;
  readonly enabledOverride?: boolean;
  /**
   * Durable per-session reviewer ROUTE override, from
   * `/approval-review model [<provider>/]<model>`. Both halves are written
   * together so a cross-provider choice cannot end up asking the session's
   * provider for a model it does not serve.
   */
  readonly modelOverride?: string;
  /** Provider half of {@link modelOverride}; absent means the configured route. */
  readonly providerOverride?: string;
  readonly reviewsThisTurn: number;
  readonly denialsStreak: number;
  readonly window: readonly boolean[];
  readonly total: number;
  readonly refused: number;
  readonly nextSeq: number;
  readonly pendingOverrides: number;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Audit ledger + live counters for the review card. */
    approvalReview: AuditView;
  }
  interface SessionProjectionStateMap {
    /** Raw fold state behind {@link SessionProjectionMap.approvalReview}. */
    approvalReview: AuditState;
  }
}
/** Derive the client-visible ledger from raw state. */
declare function auditView(state: AuditState, defaults: {
  readonly enabledByDefault: boolean;
  readonly maxReviewsPerTurn: number;
  readonly breakerTrips: boolean;
  readonly defaultReviewerModel: string;
  /** Deployment default provider half; `''` inherits the calling agent's. */
  readonly defaultReviewerProvider: string;
}): AuditView;
//#endregion
//#region src/output-language.d.ts
/** A language this plugin can emit prose in. */
type OutputLanguage = 'en' | 'zh';
/** The `language` setting: an explicit language, or follow the harness. */
type LanguageSetting = OutputLanguage | 'auto';
/**
 * Whether the resolved output language is Chinese.
 *
 * @param ctx - host context whose optional settings service owns the section.
 * @param config - resolved plugin config (only `language` is read).
 * @returns true when emitted prose should be Chinese.
 */
declare function outputIsZh(ctx: Context, config: {
  readonly language: LanguageSetting;
}): boolean;
//#endregion
//#region src/index.d.ts
declare const name = "approval-review";
/**
 * Consumers: the `/approval-review` command and the LLM seam the reviewer calls.
 * The answerer and the rationale carrier are event listeners, so they need no
 * service injection and stay mounted even if `commands` is absent.
 */
declare const inject: string[];
/** Build the default audit view for a session with no folded state yet. */
declare function emptyView(config: Config): ReturnType<typeof auditView>;
/** Register the answerer, the rationale carrier, the command, and the card feed. */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, type Config as ConfigShape, apply, emptyView, inject, name, outputIsZh };