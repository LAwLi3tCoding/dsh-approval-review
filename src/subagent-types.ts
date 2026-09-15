/**
 * Minimal local mirror of the `@deepseek-ai/dsh-subagent` types this plugin
 * consumes.
 *
 * The plugin must build in a standalone checkout that only has the harness
 * packages it actually depends on, and the subagent seam is a type-only
 * dependency here (the runtime always reaches it through `ctx.get('subagents')`).
 * Spelling the consumed subset locally keeps the build self-contained — the same
 * approach the browser half takes for `ctx.slots`. Only the members this plugin
 * reads are declared; the authoritative contract lives in
 * `@deepseek-ai/dsh-subagent/types`.
 * @module dsh-approval-review/subagent-types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/** Why a child run ended; only `completed` yields a trustworthy verdict. */
export type SubagentStopReason =
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'max-turns'
  | 'max-tokens'
  | string

/** The settled outcome of one one-shot child run. */
export interface SubagentResultSubset {
  /** The child's final assistant output. */
  readonly output: ContentBlock[]
  /** The validated structured value when an `outputSchema` was requested. */
  readonly structured?: unknown
  /** Provider-authored failure detail for a non-`completed` run. */
  readonly diagnostic?: string
  /** Why the run ended. */
  readonly stopReason: SubagentStopReason
}

/** One published one-shot child run. */
export interface SubagentRunSubset {
  /** The child's session id. */
  readonly id: string
  /** Resolves with the terminal result; does not reject on a child-level failure. */
  readonly result: Promise<SubagentResultSubset>
  /**
   * Cancel remaining work, reach child quiescence, and release resources.
   * @returns fulfillment once the child is quiescent.
   */
  dispose(): Promise<void>
}

/** The one-shot start request subset this plugin populates. */
export interface SubagentStartRequestSubset {
  /** Short display label persisted with the child. */
  readonly label?: string
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /** The spawning agent; the in-process providers fork from its session. */
  readonly parent: Agent
  /** Cancellation channel for the run. */
  readonly signal: AbortSignal
  /** Optional reviewer provider/model overrides. */
  readonly agentOptions?: { readonly provider?: string; readonly model?: string }
  /** Object-rooted JSON Schema for the child's structured result. */
  readonly outputSchema?: ObjectJsonSchema
  /** Absolute delegation-depth cap; the reviewer uses 0 to stay non-delegating. */
  readonly maxDepth?: number
  /** Child tool scoping, applied as a scoped restriction in the child. */
  readonly toolFilter?: { readonly allow: readonly string[] }
}

/** The `ctx.subagents` surface this plugin uses. */
export interface SubagentStarter {
  /**
   * Establish one one-shot child run from the named provider.
   * @param name - registered provider name (`fork` / `spawn` / `acp`).
   * @param request - the start request.
   * @returns the published run handle.
   */
  start(name: string, request: SubagentStartRequestSubset): Promise<SubagentRunSubset>
}

// Aliases keep the reviewer implementation readable.
export type SubagentRun = SubagentRunSubset
export type SubagentStartRequest = SubagentStartRequestSubset
