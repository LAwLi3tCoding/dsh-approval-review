/**
 * Subagent-backed reviewer.
 *
 * This is a CAPABILITY expansion over a plain model call: `dsh-auto-review`
 * (and the first cut of this plugin) asked a model to judge the evidence packet
 * it was handed. A subagent reviewer can additionally go READ the workspace —
 * `read` / `glob` / `grep` only — so "is this path actually inside the repo?",
 * "does this file contain what the command claims?" become answerable facts
 * instead of guesses from the argument text.
 *
 * Safety is structural, not prompt-based:
 * - the child's tool face is restricted with `toolFilter`, so the named tools
 *   vanish from its prompt AND refuse to execute (one visibility);
 * - `maxDepth: 1` is the child's own depth: it may exist, and it may not
 *   delegate further (a grandchild would be depth 2);
 * - it has no write or exec tool, so a compromised reviewer cannot act on the
 *   boundary it is guarding;
 * - a child that exists for the duration of a review is REGISTERED with the
 *   runtime as soon as `start()` resolves, before its first step can ask, and
 *   its own approval requests are delegated — so a deployment that widens
 *   `reviewer.tools` still cannot make the reviewer's asks recurse into the
 *   answerer it serves.
 * @module dsh-approval-review/subagent-reviewer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { SubagentRun, SubagentStartRequest, SubagentStarter } from './subagent-types.ts'
import { buildReviewerSystemPrompt, buildReviewerUserMessage, parseVerdict, type ReviewCallResult } from './reviewer.ts'
import type { ReviewVerdict } from './review-types.ts'

/**
 * The reviewer's requested structured output. An object-rooted schema is the
 * reliable channel: a subagent returns it validated rather than as text this
 * plugin has to salvage.
 */
export const REVIEWER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['allow', 'deny', 'uncertain'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    reason: { type: 'string' },
    suggestion: { type: 'string' },
  },
  required: ['decision', 'risk', 'reason'],
  additionalProperties: false,
} as const

/** Everything the subagent reviewer needs to judge one action. */
export interface SubagentReviewInput {
  /** Provider route for the reviewer model; unset inherits the parent's. */
  readonly provider?: string
  /** Model id for the reviewer; unset inherits the parent's. */
  readonly model?: string
  /** Subagent backend to run the reviewer on. */
  readonly reviewerProvider: string
  /** The reviewer child's tool allow-list (must be non-empty). */
  readonly reviewerTools: readonly string[]
  /** Hard deadline in milliseconds. */
  readonly timeoutMs: number
  /** The agent the approval request belongs to; the child is forked from it. */
  readonly parent: Agent
  /**
   * Called with the child's session id as soon as the child exists. The runtime
   * uses it to mark the child as a reviewer, so the child's own approval asks
   * are delegated instead of reviewed. Returns the release for that mark.
   */
  readonly registerChildSession?: (sessionId: string) => () => void
  /** The evidence packet, already bounded and redacted. */
  readonly evidence: {
    readonly toolName: string
    readonly argumentsText: string
    readonly transcript: string
    readonly askReason?: string
  }
  /** Ruling policy text; the shipping policy when unset. */
  readonly policyText?: string
  /** Extra deployment guidance. */
  readonly guidance?: string
  /** Cancellation from the approval request. */
  readonly signal?: AbortSignal
}

/** Join text blocks from a child's output, walking nested tool-result blocks. */
function childText(blocks: readonly ContentBlock[]): string {
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
 * Whether a thrown value looks like a missing subagent provider, which is a
 * deployment misconfiguration rather than a reviewer judgement. Reported
 * separately so an operator can tell "the reviewer said no" from "the reviewer
 * was never runnable".
 * @param error - the thrown value.
 * @returns a short classification phrase.
 */
function describeSubagentFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/not registered|no provider|unknown provider/iu.test(message)) {
    return `subagent provider unavailable: ${message.slice(0, 160)}`
  }
  return message.length > 200 ? `${message.slice(0, 200)}…` : message
}

/**
 * Run one reviewer as a forked subagent and return its verdict.
 *
 * Every failure path resolves rather than throwing, so the answerer never fails
 * open: a missing provider, a timeout, a cancelled turn, or a child that
 * answered nothing all land on the caller's failure policy.
 * @param ctx - context providing the `subagents` service.
 * @param input - reviewer route, tool face, parent agent, and evidence.
 * @returns the verdict, or a failure description.
 */
export async function runSubagentReviewer(
  ctx: Context,
  input: SubagentReviewInput,
): Promise<ReviewCallResult> {
  const started = Date.now()
  const subagents = ctx.get('subagents') as SubagentStarter | undefined
  if (subagents === undefined) {
    return { failure: 'no subagents service is mounted; the reviewer cannot run', durationMs: 0 }
  }
  if (input.signal?.aborted === true) {
    return { failure: 'cancelled before dispatch', durationMs: 0 }
  }

  const schema = REVIEWER_OUTPUT_SCHEMA
  assertObjectJsonSchema(schema)

  // The evidence message is built by the SAME function the direct reviewer uses,
  // so the untrusted-data fence and the redaction path cannot drift apart
  // between the two modes.
  const evidence = buildReviewerUserMessage({
    toolName: input.evidence.toolName,
    argumentsText: input.evidence.argumentsText,
    transcript: input.evidence.transcript,
    ...input.evidence.askReason === undefined ? {} : { askReason: input.evidence.askReason },
  })
  const prompt: ContentBlock[] = [
    {
      type: 'text',
      text: `${buildReviewerSystemPrompt({ ...input.policyText === undefined ? {} : { policyText: input.policyText }, ...input.guidance === undefined ? {} : { guidance: input.guidance } })}\n\nYou may read the workspace with read/glob/grep to check the evidence. Do not attempt to run, modify, or approve anything. Return the verdict as the structured result.`,
    },
    ...evidence.content,
  ]

  const request: SubagentStartRequest = {
    label: `approval-review: ${input.evidence.toolName}`,
    prompt,
    parent: input.parent,
    signal: input.signal ?? new AbortController().signal,
    // The reviewer is a READER. An empty allow-list would leave it with the
    // parent's whole tool face, so a misconfigured empty list is refused here
    // rather than silently widening the child.
    toolFilter: input.reviewerTools.length > 0 ? { allow: [...input.reviewerTools] } : { allow: ['read', 'glob', 'grep'] },
    // `maxDepth` is the child's ABSOLUTE delegation depth, not "how many more
    // levels from here": the seam computes `parentDepth + 1` and rejects a cap
    // it would exceed. The reviewer child therefore sits at depth 1, and 1 is
    // the smallest cap that lets it start at all — while still refusing any
    // grandchild it might try to spawn (depth 2). `0` reads like "no further
    // delegation" and is in fact "never start": it threw
    // `subagent depth 1 exceeds maxDepth 0` on every review, which the
    // fail-closed default then turned into a silent automatic denial.
    maxDepth: 1,
    outputSchema: schema as unknown as SubagentStartRequest['outputSchema'],
    ...input.provider === undefined && input.model === undefined
      ? {}
      : {
        agentOptions: {
          ...input.provider === undefined ? {} : { provider: input.provider },
          ...input.model === undefined ? {} : { model: input.model },
        },
      },
  }

  let run: SubagentRun | undefined
  let releaseChild: (() => void) | undefined
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true }, input.timeoutMs)
  try {
    const started0 = subagents.start(input.reviewerProvider, request)
    const raced = await Promise.race([
      started0,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('reviewer start exceeded its deadline')), input.timeoutMs)
      }),
    ])
    run = raced
    // Mark the child BEFORE awaiting its result: its first step can already
    // raise an approval, and an unmarked child would be reviewed by the very
    // answerer this review is serving.
    releaseChild = input.registerChildSession?.(raced.id)
    const result = await Promise.race([
      raced.result,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`reviewer timed out after ${input.timeoutMs} ms`)), input.timeoutMs)
      }),
    ])
    const durationMs = Date.now() - started
    if (timedOut) return { failure: `reviewer timed out after ${input.timeoutMs} ms`, durationMs }
    if (result.stopReason !== 'completed') {
      return {
        failure: result.diagnostic === undefined
          ? `reviewer child ended with "${result.stopReason}"`
          : `reviewer child ended with "${result.stopReason}": ${result.diagnostic}`,
        durationMs,
      }
    }
    // Prefer the validated structured value; fall back to parsing the child's
    // text, because a provider may not have honored the schema.
    const structured = result.structured
    const fromStructured = structured === undefined
      ? undefined
      : parseVerdict(JSON.stringify(structured))
    const verdict: ReviewVerdict | undefined = fromStructured ?? parseVerdict(childText(result.output))
    if (verdict === undefined) {
      return {
        failure: `reviewer returned no usable verdict: ${childText(result.output).trim().slice(0, 160)}`,
        durationMs,
      }
    }
    return { verdict, durationMs }
  } catch (error: unknown) {
    return {
      failure: timedOut
        ? `reviewer timed out after ${input.timeoutMs} ms`
        : describeSubagentFailure(error),
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
    // The child's mark is released only after its run settles, so an ask that
    // races the last step still finds the child registered.
    releaseChild?.()
    // A settled-but-undisposed run leaks its child session; disposal is
    // idempotent, so it is safe on every path including the failure ones.
    if (run !== undefined) await run.dispose().catch(() => undefined)
  }
}
