import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { runReviewerCall, buildReviewerUserMessage } from '../src/reviewer.ts'
import { runSubagentReviewer } from '../src/subagent-reviewer.ts'
import type { SubagentRun, SubagentStarter } from '../src/subagent-types.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

const evidence = { toolName: 'bash', argumentsText: '{"command":"true"}', transcript: '' }
const message = buildReviewerUserMessage(evidence)
const limits = { maxTokens: 256, temperature: 0, timeoutMs: 20 }

describe('bounded reviewer lifecycle', () => {
  it('feeds inspection evidence back to the isolated model before deciding', async () => {
    const requests: Array<{ messages: unknown; tools?: unknown }> = []
    let inspected = ''
    const ctx = { llm: { stream: async function* (options: { messages: unknown; tools?: unknown }) {
      requests.push(options)
      if (requests.length === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'inspect-1', name: 'inspect_path', arguments: '{"path":"probe.sh","mode":"read"}' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"decision":"allow","risk":"low","reason":"verified bounded script"}' } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } } as unknown as Context
    const result = await runReviewerCall(ctx, { provider: 'test', model: 'test' }, 'isolated policy', message, {
      ...limits, timeoutMs: 1000, inspect: async args => { inspected = args; return 'verified-probe-content' },
    })
    expect(JSON.parse(inspected).path).toBe('probe.sh')
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1]!.messages)).toContain('verified-probe-content')
    expect(result.verdict?.decision).toBe('allow')
  })

  it('bounds repeated inspection to four calls even if the model never decides', async () => {
    let inspections = 0
    let dispatches = 0
    const ctx = { llm: { stream: async function* () {
      dispatches++
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'inspect-' + dispatches, name: 'inspect_path', arguments: '{"path":"probe.sh","mode":"read"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } } as unknown as Context
    const result = await runReviewerCall(ctx, { provider: 'test', model: 'test' }, 'policy', message, {
      ...limits, timeoutMs: 1000, inspect: async () => { inspections++; return 'evidence' },
    })
    expect(inspections).toBe(4)
    expect(dispatches).toBe(5)
    expect(result.failure).toContain('budget exhausted')
    expect(result.verdict).toBeUndefined()
  })

  it('returns on timeout even when a direct adapter ignores AbortSignal', async () => {
    const ctx = { llm: { stream: async function* () { await new Promise(() => {}); yield {} } } } as unknown as Context
    const result = await runReviewerCall(ctx, { provider: 'test', model: 'test' }, 'policy', message, limits)
    expect(result.failure).toContain('timed out')
    expect(result.durationMs).toBeLessThan(500)
  })

  it('cancels direct review promptly even when a provider never yields', async () => {
    const ctx = { llm: { stream: async function* () { await new Promise(() => {}); yield {} } } } as unknown as Context
    const controller = new AbortController()
    const pending = runReviewerCall(ctx, { provider: 'test', model: 'test' }, 'policy', message, { ...limits, timeoutMs: 10000, signal: controller.signal })
    controller.abort()
    const result = await pending
    expect(result.failure).toContain('cancelled')
    expect(result.durationMs).toBeLessThan(500)
  })

  it('disposes a child that appears after the start deadline', async () => {
    let finishStart!: (run: SubagentRun) => void
    let disposed = false
    const ctx = new Context()
    const stub: SubagentStarter = { start: () => new Promise(resolve => { finishStart = resolve }) }
    ctx.provide('subagents', stub as never)
    const result = await runSubagentReviewer(ctx, {
      parent: { session: { header: { delegationDepth: 2 } } } as Agent,
      reviewerProvider: 'spawn', reviewerTools: ['read'], timeoutMs: 20, evidence,
    })
    expect(result.failure).toContain('timed out')
    finishStart({ id: 'late-child', result: new Promise(() => {}), dispose: async () => { disposed = true } })
    await Promise.resolve()
    expect(disposed).toBe(true)
  })

  it('does not let a hanging dispose delay a completed verdict', async () => {
    const ctx = new Context()
    ctx.provide('subagents', { start: async () => ({ id: 'child', result: Promise.resolve({ stopReason: 'completed', output: [], structured: { decision: 'allow', risk: 'low', reason: 'routine' } }), dispose: () => new Promise(() => {}) }) } as never)
    const result = await runSubagentReviewer(ctx, {
      parent: { session: { header: {} } } as Agent,
      reviewerProvider: 'spawn', reviewerTools: ['read'], timeoutMs: 20, evidence,
    })
    expect(result.verdict?.decision).toBe('allow')
  })
})
