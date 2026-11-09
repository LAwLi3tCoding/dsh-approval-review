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
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
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
    await Promise.resolve()
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
    await Promise.resolve()
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

  it('does NOT request a structured-output schema', async () => {
    // Requesting one makes the driver inject a `structured_output` tool the child
    // must call, then rewrites a completed run to `error` when it answers in text
    // instead. That is how a landable verdict got thrown away as a failure.
    const stub = new FakeSubagents()
    await runSubagentReviewer(mounted(stub), input())
    expect(stub.calls[0]!.request.outputSchema).toBeUndefined()
  })

  it('parses the verdict out of the child text answer', async () => {
    const stub = new FakeSubagents()
    stub.structured = undefined
    stub.text = 'Thinking…\n{"decision":"deny","risk":"high","reason":"exfiltrates the token"}'
    const result = await runSubagentReviewer(mounted(stub), input())
    expect(result.verdict).toMatchObject({ decision: 'deny', risk: 'high' })
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
    expect(stub.calls[0]!.request.persona).toContain('"decision"')
    expect(stub.calls[0]!.request.persona).toContain('NOT the action')
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

describe('reviewer isolation', () => {
  it('removes execution and delegation tools even if configured', async () => {
    const stub = new FakeSubagents()
    await runSubagentReviewer(mounted(stub), input({ reviewerTools: ['read', 'bash', 'write', 'spawn'] }))
    expect(stub.calls[0]!.request.toolFilter).toEqual({ allow: ['read'] })
  })
  it('allows reviews of nested agents without permitting further delegation', async () => {
    const stub = new FakeSubagents()
    const nested = { session: { header: { delegationDepth: 3 } } } as Agent
    await runSubagentReviewer(mounted(stub), input({ parent: nested }))
    expect(stub.calls[0]!.request.maxDepth).toBe(4)
  })
})

/** Models the documented serial creation barrier, not the model/provider itself. */
function modernHost(options: { failScope?: boolean; omitLifecycle?: boolean; holdDisposal?: Promise<void>; holdStartup?: Promise<void> } = {}) {
  const ctx = new Context()
  let allowed: readonly string[] | undefined
  let policy = ''
  let guard: ((exec: { name: string }) => string | undefined) | undefined
  let steps = 0
  let disposed = false
  let rolledBack = false
  let specSeen: Parameters<NonNullable<SubagentStarter['startActivation']>>[0] | undefined
  const service: SubagentStarter = {
    async startActivation(spec) {
      specSeen = spec
      await options.holdStartup
      const child = {
        id: spec.childId,
        ctx: {
          tools: { restrict(filter: { allow: readonly string[] }) {
            if (options.failScope) throw new Error('scope installation failed')
            allowed = filter.allow
          }, guard(check: (exec: { name: string }) => string | undefined) { guard = check } },
          systemPrompt: {
            getSectionOrder: () => 10,
            section(section: { text: string }) { policy = section.text },
          },
        },
      } as unknown as Agent
      try {
        if (!options.omitLifecycle) await ctx.serial('agent/created', { agent: child, source: 'create' } as never)
      } catch (error) { rolledBack = true; throw error }
      if (!options.omitLifecycle) {
        // A step is released only after every listener completed.
        expect(allowed).toEqual(['read', 'glob', 'grep'])
        expect(policy).toContain('JSON')
        steps += 1
      }
      return {
        childId: spec.childId,
        result: Promise.resolve({ output: [{ type: 'text' as const, text: '{"decision":"allow","risk":"low","reason":"safe"}' }], stopReason: 'completed' }),
        async dispose() { await options.holdDisposal; disposed = true },
      }
    },
  }
  ctx.provide('subagents', service as never)
  return {
    ctx,
    get spec() { return specSeen },
    get steps() { return steps },
    get disposed() { return disposed },
    get rolledBack() { return rolledBack },
    execute(name: string) { if (guard?.({ name }) !== undefined) throw new Error('tool denied'); return name },
  }
}

describe('modern subagent activation isolation', () => {
  it('installs policy and read-only scope before first step, with caller-only delivery', async () => {
    const host = modernHost()
    const registered: string[] = []
    const result = await runSubagentReviewer(host.ctx, input({ registerChildSession: id => { registered.push(id); return () => {} } }))
    expect(result.verdict?.decision).toBe('allow')
    expect(host.steps).toBe(1)
    expect(host.spec?.delivery).toBe('caller')
    expect(host.spec?.childId).toBe(registered[0])
    expect(host.spec?.request).not.toHaveProperty('persona')
    expect(host.spec?.request).not.toHaveProperty('toolFilter')
    expect(host.execute('read')).toBe('read')
    expect(() => host.execute('bash')).toThrow('tool denied')
    expect(() => host.execute('write')).toThrow('tool denied')
    expect(() => host.execute('subagent')).toThrow('tool denied')
  })

  it('fails creation before any step when hard scoping throws', async () => {
    const host = modernHost({ failScope: true })
    const result = await runSubagentReviewer(host.ctx, input())
    expect(result.verdict).toBeUndefined()
    expect(result.failure).toContain('scope installation failed')
    expect(host.rolledBack).toBe(true)
    expect(host.steps).toBe(0)
  })

  it('does not trust an activation that skipped the initialization barrier', async () => {
    const host = modernHost({ omitLifecycle: true })
    const result = await runSubagentReviewer(host.ctx, input())
    expect(result.verdict).toBeUndefined()
    expect(result.failure).toContain('read-only scope')
    expect(host.disposed).toBe(true)
  })

  it('keeps recursion protection until child disposal settles', async () => {
    let settle!: () => void
    let released = false
    const host = modernHost({ holdDisposal: new Promise<void>(resolve => { settle = resolve }) })
    await runSubagentReviewer(host.ctx, input({ registerChildSession: () => () => { released = true } }))
    expect(released).toBe(false)
    settle()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(released).toBe(true)
  })
})


it('rejects a late modern creation after timeout before model work and retains recursion guard until then', async () => {
  let start!: () => void
  let released = false
  const host = modernHost({ holdStartup: new Promise<void>(resolve => { start = resolve }) })
  const result = await runSubagentReviewer(host.ctx, input({
    timeoutMs: 5, registerChildSession: () => () => { released = true },
  }))
  expect(result.failure).toContain('timed out')
  expect(released).toBe(false)
  start()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(host.steps).toBe(0)
  expect(host.rolledBack).toBe(true)
  expect(released).toBe(true)
})


it('enforces latest real scoped tools guard through native dispatch without changing parent capabilities', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolsService)
  await ctx.plugin(NativeExecutor)
  let writes = 0
  const tool = (name: string): ToolDefinition => ({
    name, description: name, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() { if (name === 'write') writes += 1; return name },
  })
  for (const name of ['read', 'glob', 'grep', 'write']) ctx.tools.register(tool(name))
  let scope: Scope | undefined
  const service: SubagentStarter = {
    async startActivation(spec) {
      const child = { id: spec.childId } as unknown as Agent
      await ctx.plugin(Object.assign((inner: Context) => {
        scope = createScope(inner, child)
        Object.assign(child, { ctx: scope.ctx })
      }, { inject: ['tools', 'systemPrompt'] }))
      await ctx.serial('agent/created', { agent: child, source: 'create' } as never)
      // A new own-scope tool bypasses the inherited visibility filter, so the
      // execution guard, rather than prompt hiding, must stop its body.
      scope!.ctx.tools.register(tool('write'))
      const dispatch = (name: string, agent?: Agent) => executeModelToolFixture(ctx, {
        name, arguments: {}, callId: ToolCallId(`call-${name}`),
        signal: new AbortController().signal, ...(agent ? { agent } : {}),
      })
      const denied = await dispatch('write', child)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('read-only')
      expect(writes).toBe(0)
      expect((await dispatch('read', child)).isError).toBeFalsy()
      expect((await dispatch('write')).isError).toBeFalsy()
      expect(writes).toBe(1)
      const assembly = await ctx.systemPrompt.assemble({ scope: child })
      expect(JSON.stringify(assembly)).toContain('JSON')
      expect(assembly.sections).toHaveLength(1)
      expect(assembly.sections[0]?.name).toBe('deployment:persona-prefix')
      return {
        childId: spec.childId,
        result: Promise.resolve({ output: [{ type: 'text' as const, text: '{"decision":"allow","risk":"low","reason":"safe"}' }], stopReason: 'completed' }),
        async dispose() { await scope?.dispose() },
      }
    },
  }
  ctx.provide('subagents', service as never)
  const result = await runSubagentReviewer(ctx, input())
  expect(result.failure).toBeUndefined()
  expect(result.verdict?.decision).toBe('allow')
})
