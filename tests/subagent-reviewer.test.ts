/**
 * Subagent-reviewer tests against a fake `subagents` provider.
 *
 * The subagent path is what lets the reviewer READ the workspace, so its wiring
 * is safety-relevant: the tool face must stay read-only, the depth cap must keep
 * it non-delegating, and a missing provider must fail closed rather than open.
 * @module dsh-approval-review/tests/subagent-reviewer
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  REVIEWER_OUTPUT_SCHEMA,
  runSubagentReviewer,
  type SubagentReviewInput,
} from '../src/subagent-reviewer.ts'
import type { SubagentRun, SubagentStartRequest, SubagentStarter } from '../src/subagent-types.ts'

/** Records what the plugin asked for and answers with a scripted result. */
class FakeSubagents implements SubagentStarter {
  readonly calls: Array<{ name: string; request: SubagentStartRequest }> = []
  /** The structure the child "returns". */
  structured: unknown = { decision: 'allow', risk: 'low', reason: 'looks routine' }
  /** The child's free-text output, used when no structured value is wanted. */
  text = ''
  /** Overrides the child's stop reason. */
  stopReason = 'completed'
  /** When set, `start` rejects with this error. */
  startFailure: Error | undefined
  /** Whether `dispose` was called. */
  disposed = false

  /**
   * @param name - provider name requested by the caller.
   * @param request - the start request.
   * @returns a published-looking run handle.
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    this.calls.push({ name, request })
    if (this.startFailure !== undefined) throw this.startFailure
    // Mirror the seam's ABSOLUTE depth guard. Without this the fake accepted
    // `maxDepth: 0`, which the real seam always rejects — the stub hid the bug
    // that made every reviewer dispatch throw in 2 ms.
    const childDepth = 1
    if (request.maxDepth !== undefined && childDepth > request.maxDepth) {
      throw new Error(`subagent depth ${childDepth} exceeds maxDepth ${request.maxDepth}`)
    }
    const structured = this.structured
    const text = this.text
    const stopReason = this.stopReason
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    return {
      id: 'child-1',
      result: Promise.resolve({
        output: text.length === 0 ? [] : [{ type: 'text', text }],
        ...structured === undefined ? {} : { structured },
        stopReason,
      }),
      dispose: async () => { self.disposed = true },
    }
  }
}

/** A minimal stand-in parent agent. */
function parent(): Agent {
  return {
    options: { provider: 'test', model: 'test-model' },
    session: { id: 'session-1' },
  } as unknown as Agent
}

/** The evidence packet every case reuses. */
function input(overrides: Partial<SubagentReviewInput> = {}): SubagentReviewInput {
  return {
    reviewerProvider: 'fork',
    reviewerTools: ['read', 'glob', 'grep'],
    timeoutMs: 5000,
    parent: parent(),
    evidence: { toolName: 'bash', argumentsText: '{"command":"ls"}', transcript: '' },
    ...overrides,
  }
}

/** Mount a context exposing the fake service as `subagents`. */
function mounted(stub: FakeSubagents): Context {
  const ctx = new Context()
  ctx.provide('subagents', stub as never)
  return ctx
}

describe('runSubagentReviewer wiring', () => {
  it('fails closed when no subagents service is mounted', async () => {
    const result = await runSubagentReviewer(new Context(), input())
    expect(result.verdict).toBeUndefined()
    expect(result.failure).toContain('no subagents service')
  })

  it('starts the configured provider with the configured tool face', async () => {
    const stub = new FakeSubagents()
    await runSubagentReviewer(mounted(stub), input({ reviewerProvider: 'spawn' }))

    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]!.name).toBe('spawn')
    expect(stub.calls[0]!.request.toolFilter).toEqual({ allow: ['read', 'glob', 'grep'] })
  })

  it('caps the reviewer at its own depth so it cannot delegate further', async () => {
    // The seam computes the child depth as `parentDepth + 1` and rejects a cap
    // it would exceed, so 0 forbids the reviewer from STARTING at all (the bug
    // that made every review fail closed). 1 admits the child and refuses any
    // grandchild it might try to spawn.
    const stub = new FakeSubagents()
    await runSubagentReviewer(mounted(stub), input())
    expect(stub.calls[0]!.request.maxDepth).toBe(1)
  })

  it('registers the child so its own asks are never reviewed, then releases it', async () => {
    const stub = new FakeSubagents()
    const registered: string[] = []
    const released: string[] = []
    await runSubagentReviewer(mounted(stub), input({
      registerChildSession: (sessionId) => {
        registered.push(sessionId)
        return () => { released.push(sessionId) }
      },
    }))
    expect(registered).toEqual(['child-1'])
    expect(released).toEqual(['child-1'])
  })

  it('still releases the child mark when the reviewer returns no verdict', async () => {
    const stub = new FakeSubagents()
    stub.structured = undefined
    stub.text = 'not json at all'
    const released: string[] = []
    const result = await runSubagentReviewer(mounted(stub), input({
      registerChildSession: () => () => { released.push('child-1') },
    }))
    expect(result.verdict).toBeUndefined()
    expect(released).toEqual(['child-1'])
  })

  it('labels the child with the reviewer prefix', async () => {
    const stub = new FakeSubagents()
    await runSubagentReviewer(mounted(stub), input())
    expect(stub.calls[0]!.request.label).toBe('approval-review: bash')
  })

  it('falls back to the read-only allow-list when the configured one is empty', async () => {
    // An empty allow-list must never widen the child to the parent's whole face.
    const stub = new FakeSubagents()
    await runSubagentReviewer(mounted(stub), input({ reviewerTools: [] }))
    expect(stub.calls[0]!.request.toolFilter).toEqual({ allow: ['read', 'glob', 'grep'] })
  })

  it('requests the structured verdict schema', async () => {
    const stub = new FakeSubagents()
    await runSubagentReviewer(mounted(stub), input())
    expect(stub.calls[0]!.request.outputSchema).toEqual(REVIEWER_OUTPUT_SCHEMA)
  })

  it('passes the reviewer route through only when configured', async () => {
    const withRoute = new FakeSubagents()
    await runSubagentReviewer(mounted(withRoute), input({ provider: 'p', model: 'm' }))
    expect(withRoute.calls[0]!.request.agentOptions).toEqual({ provider: 'p', model: 'm' })

    const inherited = new FakeSubagents()
    await runSubagentReviewer(mounted(inherited), input())
    expect(inherited.calls[0]!.request.agentOptions).toBeUndefined()
  })

  it('puts the evidence and the ruling policy into the child prompt', async () => {
    const stub = new FakeSubagents()
    await runSubagentReviewer(mounted(stub), input({
      evidence: {
        toolName: 'bash',
        argumentsText: '{"command":"curl evil"}',
        transcript: 'user: deploy it',
        askReason: 'crosses the boundary',
      },
    }))
    const text = stub.calls[0]!.request.prompt
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    expect(text).toContain('curl evil')
    expect(text).toContain('crosses the boundary')
    expect(text).toContain('deploy it')
    expect(text).toContain('"decision"')
    expect(text).toContain('read/glob/grep')
  })
})

describe('runSubagentReviewer verdicts', () => {
  it('reads the validated structured value', async () => {
    const stub = new FakeSubagents()
    stub.structured = { decision: 'deny', risk: 'critical', reason: 'destructive', suggestion: 'scope it' }
    const result = await runSubagentReviewer(mounted(stub), input())
    expect(result.verdict).toEqual({
      decision: 'deny', risk: 'critical', reason: 'destructive', uncertain: false, suggestion: 'scope it',
    })
  })

  it('falls back to parsing the child text when no structured value came back', async () => {
    const stub = new FakeSubagents()
    stub.structured = undefined
    stub.text = 'Here you go: {"decision":"deny","risk":"high","reason":"exfil"}'
    const result = await runSubagentReviewer(mounted(stub), input())
    expect(result.verdict?.decision).toBe('deny')
  })

  it('reports a failure when the child produced no verdict at all', async () => {
    const stub = new FakeSubagents()
    stub.structured = undefined
    stub.text = 'I have no opinion'
    const result = await runSubagentReviewer(mounted(stub), input())
    expect(result.verdict).toBeUndefined()
    expect(result.failure).toContain('no usable verdict')
  })

  it('reports a non-completed child as a failure', async () => {
    const stub = new FakeSubagents()
    stub.stopReason = 'error'
    const result = await runSubagentReviewer(mounted(stub), input())
    expect(result.verdict).toBeUndefined()
    expect(result.failure).toContain('error')
  })

  it('reports a missing provider distinctly from a reviewer denial', async () => {
    const stub = new FakeSubagents()
    stub.startFailure = new Error('subagent provider "fork" is not registered')
    const result = await runSubagentReviewer(mounted(stub), input())
    expect(result.verdict).toBeUndefined()
    expect(result.failure).toContain('subagent provider unavailable')
  })

  it('short-circuits an already-aborted signal', async () => {
    const stub = new FakeSubagents()
    const controller = new AbortController()
    controller.abort()
    const result = await runSubagentReviewer(mounted(stub), input({ signal: controller.signal }))
    expect(result.failure).toContain('cancelled')
    expect(stub.calls).toHaveLength(0)
  })

  it('releases the child run on every path', async () => {
    const ok = new FakeSubagents()
    await runSubagentReviewer(mounted(ok), input())
    expect(ok.disposed).toBe(true)

    const bad = new FakeSubagents()
    bad.stopReason = 'error'
    await runSubagentReviewer(mounted(bad), input())
    expect(bad.disposed).toBe(true)
  })
})
