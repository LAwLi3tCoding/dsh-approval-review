/**
 * The Jev reviewer engine: one typed HTTP request to TypeSafe's System One
 * endpoint, and the code-side logic that turns its answers into a verdict.
 *
 * The contract with the rest of the plugin is deliberately narrow: this module
 * returns the same {@link ReviewCallResult} the LLM engines return, so every
 * gate, breaker, cache and audit path downstream stays engine-agnostic.
 *
 * Two properties are load-bearing:
 *
 * - **Fail closed.** Missing key, HTTP failure, timeout, non-JSON body, a
 *   missing or unparsable answer — every one returns `failure` and no verdict,
 *   and the caller applies `onReviewerFailure`. Nothing here ever guesses an
 *   `allow`.
 * - **Thresholds live in code, not in the model.** Jev returns probabilities;
 *   the decisions (prohibition hit, uncertain, bounded scope) are made here so
 *   they can be reviewed, tested and retuned without touching the rubric.
 *
 * @module dsh-approval-review/jev-reviewer
 */

import type { RiskLevel, ReviewVerdict, UserAuthorization } from './review-types.ts'
import type { ReviewCallResult, ReviewEvidence } from './reviewer.ts'
import {
  buildJevQuestions,
  JEV_AUTHORIZATION_OPTIONS,
  JEV_PERMIT_OPTIONS,
  JEV_PROHIBITION_LABELS,
  JEV_QUESTION_IDS,
  JEV_RISK_OPTIONS,
} from './jev-questions.ts'

/** One prohibition answer, resolved. */
export interface JevProhibitionHit {
  /** Question id the probability came from. */
  readonly id: string
  /** Probability that the prohibition applies. */
  readonly probability: number
}

/** The validated answer set, reduced to what the verdict needs. */
export interface JevAnswers {
  /** Permit answer and the probability of the option it picked. */
  readonly permit: { readonly choice: string; readonly probability: number }
  /** Risk grade the model reported. */
  readonly risk: RiskLevel
  /** Authorization level, or `unknown` when the answer was not a known level. */
  readonly authorization: UserAuthorization
  /** Raw probability that the scope is bounded; the threshold is applied later. */
  readonly scopeProbability: number
  /** Probability for each of the four prohibitions. */
  readonly prohibitions: readonly JevProhibitionHit[]
}

/** The three probabilities this engine turns into decisions. */
export interface JevThresholds {
  /** Below this top probability the permit answer is treated as uncertain. */
  readonly permitProbMin: number
  /** At or above this probability a prohibition refuses the action. */
  readonly prohibitedAt: number
  /** At or above this probability the scope counts as bounded. */
  readonly scopeBoundedAt: number
}

/** Everything one Jev review needs. */
export interface JevReviewOptions extends JevThresholds {
  /** Endpoint to POST to. */
  readonly endpoint: string
  /** Model or alias for the request body. */
  readonly model: string
  /** Resolved API key; `undefined` means the environment variable was unset. */
  readonly credential: string | undefined
  /** Name of the environment variable, for the failure message only. */
  readonly apiKeyEnv: string
  /** Hard deadline for the call. */
  readonly timeoutMs: number
  /** Per-question instruction overrides. */
  readonly rubric: Readonly<Record<string, string>>
  /** The bounded, redacted evidence packet. */
  readonly evidence: ReviewEvidence
  /** Language for the generated `reason`; the rubric itself stays English. */
  readonly outputLanguage: 'en' | 'zh'
  /** True when the human authorized this exact action once, after a refusal. */
  readonly exactActionApproval: boolean
  /** Caller cancellation (a cancelled turn must not leave a request running). */
  readonly signal?: AbortSignal
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/** Raised inside the parser; the public entry point converts it to `failure`. */
class JevAnswerError extends Error {}

/** Bound an error body so a hostile or huge response cannot reach the audit. */
const ERROR_BODY_MAX = 160

/**
 * Build the `state` document: the same evidence the LLM reviewer receives, in
 * named fields Jev can reference from its instructions.
 * @param evidence - bounded, redacted evidence.
 * @param exactActionApproval - whether a one-shot human authorization applies.
 * @returns the state object for the request body.
 */
export function buildJevState(evidence: ReviewEvidence, exactActionApproval: boolean): Record<string, unknown> {
  return {
    tool: evidence.toolName,
    arguments: evidence.argumentsText,
    ask_reason: evidence.askReason ?? null,
    transcript: evidence.transcript.length > 0 ? evidence.transcript : null,
    user_intent: evidence.userIntent ?? null,
    host_exact_action_approval: exactActionApproval,
  }
}

/**
 * Build the complete request body. Exported so tests can pin its shape — in
 * particular that the API key appears only in the header, never here.
 * @param model - model or alias.
 * @param evidence - bounded, redacted evidence.
 * @param rubric - per-question instruction overrides.
 * @param exactActionApproval - whether a one-shot human authorization applies.
 * @returns the JSON body.
 */
export function buildJevRequestBody(
  model: string,
  evidence: ReviewEvidence,
  rubric: Readonly<Record<string, string>>,
  exactActionApproval: boolean,
): { readonly state: Record<string, unknown>; readonly model: string; readonly questions: ReturnType<typeof buildJevQuestions> } {
  return {
    state: buildJevState(evidence, exactActionApproval),
    model,
    questions: buildJevQuestions(rubric),
  }
}

/**
 * Read one recorded probability, rejecting what cannot be trusted.
 * @param id - question id, for the error message.
 * @param value - candidate value.
 * @returns the probability.
 */
function readProbability(id: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new JevAnswerError(`answer "${id}" is not a number`)
  }
  if (value < -1e-6 || value > 1 + 1e-6) {
    throw new JevAnswerError(`answer "${id}" is outside 0..1 (${value})`)
  }
  return Math.min(1, Math.max(0, value))
}

/**
 * Read one choice answer: the picked option plus the probability of that option.
 * `confidence` is accepted as a fallback when a gateway drops `probabilities`,
 * because confidence is derived from the same distribution.
 * @param id - question id.
 * @param value - the answer object.
 * @param allowed - options this question may return.
 * @returns the picked option and its probability.
 */
function readChoice(
  id: string,
  value: unknown,
  allowed: readonly string[],
): { readonly choice: string; readonly probability: number } {
  if (typeof value !== 'object' || value === null) throw new JevAnswerError(`answer "${id}" is missing`)
  const answer = value as { readonly choice?: unknown; readonly probabilities?: unknown; readonly confidence?: unknown }
  if (typeof answer.choice !== 'string' || !allowed.includes(answer.choice)) {
    throw new JevAnswerError(`answer "${id}" has an unknown option (${JSON.stringify(answer.choice)})`)
  }
  const probabilities = answer.probabilities
  if (typeof probabilities === 'object' && probabilities !== null) {
    const raw = (probabilities as Record<string, unknown>)[answer.choice]
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return { choice: answer.choice, probability: Math.min(1, Math.max(0, raw)) }
    }
    // A distribution that omits the picked option is a contract violation, not
    // a reason to substitute a different number.
    throw new JevAnswerError(`answer "${id}" has no probability for the option it picked`)
  }
  if (typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)) {
    return { choice: answer.choice, probability: Math.min(1, Math.max(0, answer.confidence)) }
  }
  throw new JevAnswerError(`answer "${id}" carries neither probabilities nor confidence`)
}

/**
 * Validate the whole answer set. Required judgments are strict: a missing,
 * mistyped or out-of-range answer fails the review rather than being guessed.
 * The one exception is `user_authorization`, where an unrecognized value
 * degrades to `unknown` — the conservative direction, since `unknown` can never
 * widen permission in the gate.
 * @param payload - the decoded response body.
 * @returns the validated answers, or the reason they were unusable.
 */
export function parseJevAnswers(payload: unknown): { readonly answers: JevAnswers } | { readonly failure: string } {
  try {
    if (typeof payload !== 'object' || payload === null) return { failure: 'response body was not a JSON object' }
    const answers = (payload as { readonly answers?: unknown }).answers
    if (typeof answers !== 'object' || answers === null) return { failure: 'response has no "answers" object' }
    const map = answers as Record<string, unknown>

    const missing = Object.values(JEV_QUESTION_IDS).filter(id => map[id] === undefined)
    if (missing.length > 0) return { failure: `response is missing answer(s): ${missing.join(', ')}` }

    const permit = readChoice(JEV_QUESTION_IDS.permit, map[JEV_QUESTION_IDS.permit], JEV_PERMIT_OPTIONS)
    const riskAnswer = readChoice(JEV_QUESTION_IDS.risk, map[JEV_QUESTION_IDS.risk], JEV_RISK_OPTIONS)

    const authorizationRaw = map[JEV_QUESTION_IDS.authorization]
    let authorization: UserAuthorization = 'unknown'
    if (typeof authorizationRaw === 'object' && authorizationRaw !== null) {
      const choice = (authorizationRaw as { readonly choice?: unknown }).choice
      if (typeof choice === 'string' && (JEV_AUTHORIZATION_OPTIONS as readonly string[]).includes(choice)) {
        authorization = choice as UserAuthorization
      }
    }

    const scopeAnswer = map[JEV_QUESTION_IDS.scope]
    if (typeof scopeAnswer !== 'object' || scopeAnswer === null) throw new JevAnswerError(`answer "${JEV_QUESTION_IDS.scope}" is missing`)
    const scopeProbability = readProbability(JEV_QUESTION_IDS.scope, (scopeAnswer as { readonly noul?: unknown }).noul)

    const prohibitions: JevProhibitionHit[] = []
    for (const id of [
      JEV_QUESTION_IDS.prohibitedExfiltration,
      JEV_QUESTION_IDS.prohibitedCredentialProbing,
      JEV_QUESTION_IDS.prohibitedSecurityWeakening,
      JEV_QUESTION_IDS.prohibitedDestruction,
    ]) {
      const answer = map[id]
      if (typeof answer !== 'object' || answer === null) throw new JevAnswerError(`answer "${id}" is missing`)
      prohibitions.push({ id, probability: readProbability(id, (answer as { readonly noul?: unknown }).noul) })
    }

    return {
      answers: {
        permit,
        risk: riskAnswer.choice as RiskLevel,
        authorization,
        scopeProbability,
        prohibitions,
      },
    }
  } catch (error: unknown) {
    return { failure: error instanceof Error ? error.message : String(error) }
  }
}

/** Round a probability for prose; two decimals is what a human reads. */
function pct(probability: number): string {
  return probability.toFixed(2)
}

/**
 * Compose the one-sentence reason from the answers. Jev does not write prose, so
 * this template IS the rationale the ledger and the model see: it names the
 * decisive answers instead of paraphrasing them.
 * @param language - resolved output language for this verdict.
 * @param input - the decisive facts.
 * @returns one line, safe for the marker (no newlines).
 */
export function templateReason(
  language: 'en' | 'zh',
  input: {
    readonly kind: 'prohibited' | 'uncertain' | 'deny' | 'allow'
    readonly risk: RiskLevel
    readonly authorization: UserAuthorization
    readonly scopeBounded: boolean
    readonly permit: { readonly choice: string; readonly probability: number }
    readonly prohibition?: JevProhibitionHit
    readonly permitProbMin: number
  },
): string {
  const risk = input.risk
  const authorization = input.authorization
  const bounded = input.scopeBounded ? (language === 'zh' ? '是' : 'yes') : (language === 'zh' ? '否' : 'no')
  if (language === 'zh') {
    switch (input.kind) {
      case 'prohibited': {
        const label = input.prohibition === undefined
          ? ''
          : (JEV_PROHIBITION_LABELS[input.prohibition.id]?.zh ?? input.prohibition.id)
        const probability = input.prohibition === undefined ? '' : ` (${pct(input.prohibition.probability)})`
        return `拒绝：禁令命中「${label}」${probability}；风险 ${risk}；用户授权 ${authorization}；permit ${pct(input.permit.probability)}`
      }
      case 'uncertain':
        return `无法确定：permit 最高概率 ${pct(input.permit.probability)} 低于阈值 ${pct(input.permitProbMin)}（判定 ${input.permit.choice}）；风险 ${risk}；用户授权 ${authorization}`
      case 'deny':
        return `拒绝：复核判定 ${input.permit.choice}；风险 ${risk}；用户授权 ${authorization}；范围有界 ${bounded}；${pct(input.permit.probability)}`
      default:
        return `放行：风险 ${risk}；用户授权 ${authorization}；范围有界 ${bounded}；permit ${pct(input.permit.probability)}`
    }
  }
  switch (input.kind) {
    case 'prohibited': {
      const label = input.prohibition === undefined
        ? ''
        : (JEV_PROHIBITION_LABELS[input.prohibition.id]?.en ?? input.prohibition.id)
      const probability = input.prohibition === undefined ? '' : ` (${pct(input.prohibition.probability)})`
      return `Denied: prohibition "${label}"${probability}; risk ${risk}; authorization ${authorization}; permit ${pct(input.permit.probability)}`
    }
    case 'uncertain':
      return `Uncertain: permit probability ${pct(input.permit.probability)} is below ${pct(input.permitProbMin)} (answered ${input.permit.choice}); risk ${risk}; authorization ${authorization}`
    case 'deny':
      return `Denied: reviewer answered ${input.permit.choice}; risk ${risk}; authorization ${authorization}; scope bounded ${bounded}; ${pct(input.permit.probability)}`
    default:
      return `Allowed: risk ${risk}; authorization ${authorization}; scope bounded ${bounded}; permit ${pct(input.permit.probability)}`
  }
}

/**
 * Turn validated answers into the plugin's verdict.
 *
 * Order matters and is the documented policy: an absolute prohibition refuses
 * regardless of how confidently the action was permitted; low permit confidence
 * becomes `uncertain` (never a silent allow); only then does the permit answer
 * decide. `risk`, authorization and scope ride along for {@link applyVerdictGates}.
 * @param answers - validated answers.
 * @param thresholds - the configured probabilities.
 * @param language - resolved output language.
 * @returns the normalized verdict.
 */
export function verdictFromJevAnswers(
  answers: JevAnswers,
  thresholds: JevThresholds,
  language: 'en' | 'zh',
): ReviewVerdict {
  const scopeBounded = answers.scopeProbability >= thresholds.scopeBoundedAt
  const authorization = answers.authorization
  const hits = answers.prohibitions
    .filter(hit => hit.probability >= thresholds.prohibitedAt)
    .sort((left, right) => right.probability - left.probability)
  const base = {
    risk: answers.risk,
    authorization,
    scopeBounded,
    permit: answers.permit,
    permitProbMin: thresholds.permitProbMin,
  }

  if (hits.length > 0) {
    return {
      decision: 'deny',
      risk: answers.risk,
      uncertain: false,
      userAuthorization: authorization,
      scopeBounded,
      reason: templateReason(language, { ...base, kind: 'prohibited', prohibition: hits[0]! }),
    }
  }
  const uncertain = answers.permit.choice === 'uncertain' || answers.permit.probability < thresholds.permitProbMin
  if (uncertain) {
    return {
      decision: 'deny',
      risk: answers.risk,
      uncertain: true,
      userAuthorization: authorization,
      scopeBounded,
      reason: templateReason(language, { ...base, kind: 'uncertain' }),
    }
  }
  const decision = answers.permit.choice === 'permit' ? 'allow' : 'deny'
  return {
    decision,
    risk: answers.risk,
    uncertain: false,
    userAuthorization: authorization,
    scopeBounded,
    reason: templateReason(language, { ...base, kind: decision === 'allow' ? 'allow' : 'deny' }),
  }
}

/** A short, bounded excerpt of an error body for the audit record. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/gu, ' ').trim()
    if (text.length === 0) return ''
    return `: ${text.length > ERROR_BODY_MAX ? `${text.slice(0, ERROR_BODY_MAX)}…` : text}`
  } catch {
    return ''
  }
}

/**
 * Run one Jev review.
 *
 * Every failure returns `failure` instead of throwing, so the answerer never
 * fails open; the caller's `onReviewerFailure` policy decides what a reviewer
 * that could not answer means.
 * @param options - endpoint, credentials, thresholds and evidence.
 * @returns the verdict, or a description of why there is none.
 */
export async function runJevReviewer(options: JevReviewOptions): Promise<ReviewCallResult> {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started
  // Read through a function: `aborted` flips asynchronously while this call is
  // in flight, so a property check narrowed earlier would be stale.
  const aborted = (): boolean => options.signal?.aborted === true
  const credential = options.credential === undefined ? '' : options.credential.trim()
  if (credential.length === 0) {
    return { failure: `jev: ${options.apiKeyEnv} is not set, so no review was requested`, durationMs: 0 }
  }
  if (aborted()) return { failure: 'jev: review cancelled before dispatch', durationMs: 0 }

  const controller = new AbortController()
  const onAbort = (): void => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)

  try {
    const body = buildJevRequestBody(options.model, options.evidence, options.rubric, options.exactActionApproval)
    const send = options.fetchImpl ?? fetch
    const response = await send(options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The only place the credential appears. It is never logged, never put
        // in the body, and never written to the audit record.
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      return { failure: `jev: HTTP ${response.status}${await errorDetail(response)}`, durationMs: elapsed() }
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { failure: 'jev: response body was not JSON', durationMs: elapsed() }
    }
    const parsed = parseJevAnswers(payload)
    if ('failure' in parsed) return { failure: `jev: ${parsed.failure}`, durationMs: elapsed() }
    const answeredModel = (payload as { readonly model?: unknown }).model
    const verdict = verdictFromJevAnswers(parsed.answers, options, options.outputLanguage)
    return {
      verdict,
      durationMs: elapsed(),
      ...typeof answeredModel === 'string' && answeredModel.length > 0 ? { answeredModel } : {},
    }
  } catch (error: unknown) {
    const durationMs = elapsed()
    if (timedOut) return { failure: `jev: request timed out after ${options.timeoutMs} ms`, durationMs }
    if (aborted()) return { failure: 'jev: review cancelled', durationMs }
    return {
      failure: `jev: ${error instanceof Error ? error.message : String(error)}`,
      durationMs,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
