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
 * - maxDepth is parentDepth + 1; tools cannot delegate further;
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
import type { SubagentRun, SubagentStartRequest, SubagentStarter } from './subagent-types.ts'
import { buildReviewerSystemPrompt, buildReviewerUserMessage, parseVerdict, type ReviewCallResult, type ReviewEvidence } from './reviewer.ts'
import type { ReviewVerdict } from './review-types.ts'

/**
 * The verdict shape the reviewer prompt states and the parser validates.
 *
 * Kept exported (and described here) because it is the contract between
 * `buildReviewerSystemPrompt` and `parseVerdict`; it is deliberately NOT sent as
 * the subagent's `outputSchema` — see the note at the dispatch site.
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
  /** The agent the approval request belongs to; the child is composed from it. */
  readonly parent: Agent
  /**
   * Called with the child's session id as soon as the child exists. The runtime
   * uses it to mark the child as a reviewer, so the child's own approval asks
   * are delegated instead of reviewed. Returns the release for that mark.
   */
  readonly registerChildSession?: (sessionId: string) => () => void
  /** The evidence packet, already bounded and redacted. */
  readonly evidence: ReviewEvidence
  readonly exactActionApproval?: boolean

  /** Ruling policy text; the shipping policy when unset. */
  readonly policyText?: string
  /** Extra deployment guidance. */
  readonly guidance?: string
  /**
   * Language for the verdict's prose fields, resolved by the caller from the
   * harness language setting. Omitted keeps the historical English prompt.
   */
  readonly outputLanguage?: 'en' | 'zh'
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
 * Run one reviewer as an optional read-only subagent and return its verdict.
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

  // The evidence message is built by the SAME function the direct reviewer uses,
  // so the untrusted-data fence and the redaction path cannot drift apart
  // between the two modes.
  const evidence = buildReviewerUserMessage(input.evidence)
  const persona = buildReviewerSystemPrompt({
    ...input.policyText === undefined ? {} : { policyText: input.policyText },
    ...input.guidance === undefined ? {} : { guidance: input.guidance },
    ...input.outputLanguage === undefined ? {} : { outputLanguage: input.outputLanguage },
    exactActionApproval: input.exactActionApproval === true,
  })
  const prompt: ContentBlock[] = evidence.content
  const controller = new AbortController()

  const readTools = input.reviewerTools.filter(tool => ['read', 'glob', 'grep'].includes(tool))
  const request: SubagentStartRequest = {
    label: `approval-review: ${input.evidence.toolName}`,
    prompt,
    persona,
    parent: input.parent,
    signal: controller.signal,
    // The reviewer is a READER. An empty allow-list would leave it with the
    // parent's whole tool face, so a misconfigured empty list is refused here
    // rather than silently widening the child.
    toolFilter: { allow: readTools.length > 0 ? readTools : ['read', 'glob', 'grep'] },
    // Nested parent agents need a reviewer at their own next depth.
    maxDepth: (input.parent.session.header?.delegationDepth ?? 0) + 1,
    // NO `outputSchema`, deliberately. Requesting one makes the in-process
    // driver inject a `structured_output` TOOL the child must CALL to deliver
    // its answer, and the driver then rewrites a naturally-finished run:
    //
    //   if (structured !== undefined) {
    //     if (structured.captured !== undefined) return { output, structured, stopReason }
    //     if (stopReason === 'completed') return { output, stopReason: 'error' }
    //   }
    //   // subagent-in-process-driver/src/index.ts
    //
    // Our reviewer prompt instead demands "ONE JSON object and nothing else",
    // and the model complies — so the tool is never called, a COMPLETED child is
    // reported as `error`, and the caller discards a perfectly good verdict
    // (observed: a landable `{decision: allow, ...}` in the child's own log,
    // thrown away as "reviewer child ended with error"). The verdict is parsed
    // from the child's text instead, which is the same contract `mode: direct`
    // has always used.
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
  let finished = false
  let rejectDeadline!: (error: Error) => void
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
  const cancel = (): void => {
    controller.abort()
    rejectDeadline(new Error('review cancelled'))
  }
  input.signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    rejectDeadline(new Error(`reviewer timed out after ${input.timeoutMs} ms`))
  }, input.timeoutMs)
  try {
    const pending = subagents.start(input.reviewerProvider, request).then(handle => {
      // A provider may ignore cancellation while starting. Dispose late handles
      // without delaying the parent approval or leaking a child.
      if (finished) { void handle.dispose().catch(() => undefined); return handle }
      run = handle
      releaseChild = input.registerChildSession?.(handle.id)
      return handle
    })
    const raced = await Promise.race([pending, deadline])
    const result = await Promise.race([raced.result, deadline])
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
    finished = true
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', cancel)
    controller.abort()
    // Do not let an unresponsive provider's disposal defeat the review deadline.
    // Keep its reviewer identity until disposal actually settles.
    if (run !== undefined) {
      void run.dispose().catch(() => undefined).finally(() => releaseChild?.())
    } else releaseChild?.()
  }
}
