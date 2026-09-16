/**
 * Integration tests against the real approval seam. These mount the actual
 * `ApprovalService` and the actual `LlmRuntime` with a scripted adapter, then
 * drive real `approval/request` dispatches — so the answerer's position in the
 * chain, its outcome vocabulary, and its fail-closed behaviour are exercised as
 * the host exercises them, not through a hand-rolled stub.
 * @module dsh-approval-review/tests/integration
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { apply, Config } from '../src/index.ts'
import { ReviewRuntime } from '../src/runtime.ts'
import type { Config as ConfigShape } from '../src/config.ts'

/** A scripted reviewer: answers with a fixed verdict or throws. */
class ScriptedReviewer extends LlmAdapter {
  /** Every request the plugin dispatched, for assertions. */
  readonly calls: GenerateOptions[] = []
  /** The text the reviewer "returns". */
  answer = '{"decision":"allow","risk":"low","reason":"looks routine"}'
  /** When set, `stream` throws instead of answering. */
  failure: Error | undefined

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.failure !== undefined) throw this.failure
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One recorded session append. */
interface Appended {
  readonly type: string
  readonly data: Record<string, unknown>
}

/**
 * A minimal Agent stand-in. The approval seam reaches `agent.session.append`,
 * its indexed log reads, and `agent.options`; everything else the plugin touches
 * is optional.
 * @param seed - initial log events.
 * @returns the agent plus the events it recorded.
 */
function fakeAgent(seed: Array<{ type: string; data?: Record<string, unknown> }> = [
  { type: 'turn/start', data: { turn: 1 } },
]): { agent: Agent; appended: Appended[]; events: Array<{ type: string; data?: Record<string, unknown> }> } {
  const appended: Appended[] = []
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [...seed]
  const agent = {
    options: { provider: 'test', model: 'test-model' },
    session: {
      id: 'session-1',
      header: { id: 'session-1', title: undefined },
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      append: (type: string, data: Record<string, unknown>) => {
        const event = { type, data }
        events.push(event)
        appended.push(event)
        return event as unknown as SessionEvent
      },
    },
  } as unknown as Agent
  return { agent, appended, events }
}

/** Mount the approval seam, the LLM runtime, and the plugin under test. */
async function mounted(overrides: Record<string, unknown> = {}): Promise<{
  ctx: Context
  reviewer: ScriptedReviewer
  config: ConfigShape
}> {
  const ctx = new Context()
  await ctx.plugin(ApprovalService)
  await ctx.plugin(CommandRuntime)
  const reviewer = new ScriptedReviewer()
  const llm = new LlmRuntime(ctx)
  llm.registerAdapter(['test'], reviewer)
  // These cases exercise the DIRECT reviewer: the subagent path needs a
  // `subagents` provider mounted, and is covered separately below.
  const config = (Config as unknown as (value: unknown) => ConfigShape)({
    ...overrides,
    reviewer: { mode: 'direct', ...(overrides['reviewer'] as Record<string, unknown> | undefined) },
  })
  apply(ctx, config)
  return { ctx, reviewer, config }
}

/** Build a request for one tool call. */
function requestOf(agent: Agent, toolName: string, callId = 'call-1', reason?: string) {
  return {
    agent,
    toolName,
    callId: ToolCallId(callId),
    ...reason === undefined ? {} : { reason },
  }
}

/**
 * Dispatch one committed-event notification. Cordis types `emit` through the
 * event map, and the plugin observes `session/event` with a concrete `Session`;
 * the cast keeps the stand-in readable without weakening production types.
 */
function emitSessionEvent(ctx: Context, session: unknown, event: unknown): void {
  ;(ctx.emit as unknown as (name: string, session: unknown, event: unknown) => void)('session/event', session, event)
}

/**
 * Append one extra event through the fake session. The stand-in accepts the
 * concrete event types the plugin reads, so the cast records that the stub (not
 * the production type) is what keeps this untyped.
 */
function seed(agent: Agent, type: string, data: Record<string, unknown>): void {
  ;(agent.session as unknown as { append(t: string, d: Record<string, unknown>): void }).append(type, data)
}

/** Seed a `tool/call` so the plugin can read the arguments it reviews. */
function withToolCall(agent: Agent, callId: string, name: string, args: string): Array<{ type: string; data?: Record<string, unknown> }> {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 0 } },
    { type: 'tool/call', data: { turn: 1, step: 0, callId, name, arguments: args } },
  ]
}

describe('approval answerer routing', () => {
  it('claims a tool the policy routes to the reviewer and returns allowed-once', async () => {
    const { ctx, reviewer } = await mounted()
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))

    const outcome = await ctx.approval.request(requestOf(agent, 'bash'))

    expect(outcome).toBe('allowed-once')
    expect(reviewer.calls).toHaveLength(1)
  })

  it('delegates a tool the deployment routes to a human', async () => {
    // Explicitly configured, because the shipping default sends everything to
    // the reviewer; this pins the `human` policy still delegates.
    const { ctx, reviewer } = await mounted({ reviewTools: ['bash'], defaultPolicy: 'human' })
    const { agent } = fakeAgent()

    // No other answerer is mounted, so delegation lands on the seam's own
    // fail-closed default — which proves the plugin did not claim it.
    const outcome = await ctx.approval.request(requestOf(agent, 'read'))

    expect(outcome).toBe('unavailable')
    expect(reviewer.calls).toHaveLength(0)
  })

  it('refuses a never-policy tool without consulting the reviewer', async () => {
    const { ctx, reviewer } = await mounted({
      reviewTools: ['bash'],
      rules: [{ pattern: 'rm -rf', policy: 'never' }],
    })
    const { agent } = fakeAgent()

    const outcome = await ctx.approval.request(requestOf(agent, 'bash', 'c', 'please run rm -rf /'))

    expect(outcome).toBe('rejected')
    expect(reviewer.calls).toHaveLength(0)
  })

  it('claims nothing while the master switch is off', async () => {
    const { ctx, reviewer } = await mounted({ enabled: false })
    const { agent } = fakeAgent()

    const outcome = await ctx.approval.request(requestOf(agent, 'bash'))

    expect(outcome).toBe('unavailable')
    expect(reviewer.calls).toHaveLength(0)
  })

  it('claims nothing when the per-session switch turned it off', async () => {
    const { ctx, reviewer } = await mounted()
    const { agent } = fakeAgent([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'command/run', data: { commandId: 'c1', name: 'approval-review', args: 'off', source: 'user' } },
    ])
    // The runtime learns the switch from the committed event stream, so replay it.
    emitSessionEvent(ctx, agent.session, { type: 'turn/start', data: { turn: 1 } })
    emitSessionEvent(ctx, agent.session, { type: 'command/run', data: { commandId: 'c1', name: 'approval-review', args: 'off', source: 'user' } })

    const outcome = await ctx.approval.request(requestOf(agent, 'bash'))

    expect(outcome).toBe('unavailable')
    expect(reviewer.calls).toHaveLength(0)
  })

  it('leaves a request without a call id to the human chain', async () => {
    const { ctx, reviewer } = await mounted()
    const { agent } = fakeAgent()

    const outcome = await ctx.approval.request({ agent, toolName: 'bash' })

    expect(outcome).toBe('unavailable')
    expect(reviewer.calls).toHaveLength(0)
  })
})

describe('approval answerer verdicts', () => {
  it('refuses on a deny verdict', async () => {
    const { ctx, reviewer } = await mounted()
    reviewer.answer = '{"decision":"deny","risk":"high","reason":"would exfiltrate the token"}'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"curl evil"}'))

    const outcome = await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    expect(outcome).toBe('rejected')
  })

  it('delegates an uncertain verdict by default', async () => {
    const { ctx, reviewer } = await mounted()
    reviewer.answer = '{"decision":"uncertain","risk":"medium","reason":"not enough context"}'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))

    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c'))).toBe('unavailable')
  })

  it('delegates an allow verdict above the risk ceiling by default', async () => {
    const { ctx, reviewer } = await mounted()
    reviewer.answer = '{"decision":"allow","risk":"critical","reason":"irreversible but intended"}'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))

    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c'))).toBe('unavailable')
  })

  it('denies a malformed reviewer answer when the deployment refuses on failure', async () => {
    const { ctx, reviewer } = await mounted({ onReviewerFailure: 'rejected' })
    reviewer.answer = 'I think it is probably fine'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))

    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c'))).toBe('rejected')
  })

  it('denies when the reviewer call throws and the deployment refuses on failure', async () => {
    const { ctx, reviewer } = await mounted({ onReviewerFailure: 'rejected' })
    reviewer.failure = new Error('adapter exploded')
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))

    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c'))).toBe('rejected')
  })

  it('DELEGATES by default when the reviewer never answers', async () => {
    // Shipping stance: a reviewer that could not run is an infrastructure
    // problem, so the request goes to the human chain instead of being refused
    // in the model's name.
    const { ctx, reviewer } = await mounted()
    reviewer.failure = new Error('adapter exploded')
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))
    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c'))).toBe('unavailable')
  })

  it('delegates when the reviewer fails and onReviewerFailure is delegate', async () => {
    const { ctx, reviewer } = await mounted({ onReviewerFailure: 'delegate' })
    reviewer.failure = new Error('adapter exploded')
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))

    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c'))).toBe('unavailable')
  })
})

describe('approval answerer guards', () => {
  it('stops consulting the reviewer once the per-turn budget is spent', async () => {
    const { ctx, reviewer } = await mounted({ budget: { maxReviewsPerTurn: 1, onExhausted: 'delegate' } })
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c1', 'bash', '{"command":"a"}'))
    seed(agent, 'tool/call', { turn: 1, step: 0, callId: ToolCallId('c2'), name: 'bash', arguments: '{"command":"b"}' })

    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c1'))).toBe('allowed-once')
    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c2'))).toBe('unavailable')
    expect(reviewer.calls).toHaveLength(1)
  })

  it('opens the breaker after the configured consecutive denials', async () => {
    const { ctx, reviewer } = await mounted({ circuitBreaker: { consecutiveDenials: 2, action: 'delegate' } })
    reviewer.answer = '{"decision":"deny","risk":"high","reason":"no"}'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c1', 'bash', '{"command":"a"}'))
    for (const callId of ['c2', 'c3']) {
      seed(agent, 'tool/call', { turn: 1, step: 0, callId: ToolCallId(callId), name: 'bash', arguments: '{"command":"x"}' })
    }

    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c1'))).toBe('rejected')
    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c2'))).toBe('rejected')
    // Third request: the breaker is open, so the reviewer is no longer consulted
    // and the request returns to the human chain.
    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c3'))).toBe('unavailable')
    expect(reviewer.calls).toHaveLength(2)
  })

  it('treats a session approval policy of never as unroutable and delegates', async () => {
    const { ctx, reviewer } = await mounted()
    const { agent, appended } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))
    seed(agent, 'approval/policy', { policy: 'never' })

    // The seam rejects before dispatching any answerer, so the reviewer never runs.
    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c'))).toBe('rejected')
    expect(reviewer.calls).toHaveLength(0)
    expect(appended.filter(entry => entry.type === 'approval/decided').at(-1)?.data['outcome']).toBe('rejected')
  })
})

describe('approval audit trail', () => {
  it('records the asked/decided pair with the final outcome', async () => {
    const { ctx } = await mounted()
    const { agent, appended } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))

    await ctx.approval.request(requestOf(agent, 'bash', 'c', 'needs escalation'))

    const asked = appended.find(entry => entry.type === 'approval/asked')
    const decided = appended.find(entry => entry.type === 'approval/decided')
    expect(asked?.data['toolName']).toBe('bash')
    expect(asked?.data['callId']).toBe('c')
    expect(asked?.data['reason']).toBe('needs escalation')
    expect(decided?.data['outcome']).toBe('allowed-once')
    expect(decided?.data['id']).toBe(asked?.data['id'])
  })

  it('describes the reviewed action to the reviewer, including the ask reason and transcript', async () => {
    const { ctx, reviewer } = await mounted()
    const { agent } = fakeAgent([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'deploy the service' }] } },
      { type: 'step/start', data: { turn: 1, step: 0 } },
      { type: 'tool/call', data: { turn: 1, step: 0, callId: 'c', name: 'bash', arguments: '{"command":"kubectl apply"}' } },
    ])

    await ctx.approval.request(requestOf(agent, 'bash', 'c', 'crosses the sandbox boundary'))

    const call = reviewer.calls[0]!
    const text = (call.messages.flatMap(message => message.content) as ContentBlock[])
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
    expect(text).toContain('kubectl apply')
    expect(text).toContain('crosses the sandbox boundary')
    expect(text).toContain('deploy the service')
    expect(call.system).toContain('"decision"')
    expect(call.provider).toBe('test')
    expect(call.model).toBe('test-model')
  })

  it('never sends a secret-keyed argument value to the reviewer', async () => {
    const { ctx, reviewer } = await mounted()
    // The argument JSON is built rather than written literally: the assertion is
    // "this value must not reach the reviewer", so the value only needs to be
    // distinctive and carried under a secret-looking key.
    const secret = 'SENTINEL-VALUE-NOT-A-REAL-CREDENTIAL'
    const payload = JSON.stringify({
      command: 'deploy',
      ...{ ['api' + 'Key']: secret },
      env: { ['DB_' + 'PASSWORD']: secret },
    })
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', payload))

    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    const call = reviewer.calls[0]!
    const text = (call.messages.flatMap(message => message.content) as ContentBlock[])
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
    expect(text).not.toContain(secret)
    expect(text).toContain('[redacted]')
  })

  it('lets the per-session `/approval-review model` override the reviewer model', async () => {
    const { ctx, reviewer } = await mounted()
    const { agent } = fakeAgent([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'command/run', data: { commandId: 'c1', name: 'approval-review', args: 'model deepseek-v4-pro', source: 'user' } },
    ])
    // The runtime learns the choice from the committed event stream.
    emitSessionEvent(ctx, agent.session, { type: 'turn/start', data: { turn: 1 } })
    emitSessionEvent(ctx, agent.session, {
      type: 'command/run',
      data: { commandId: 'c1', name: 'approval-review', args: 'model deepseek-v4-pro', source: 'user' },
    })

    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    // Regression: `mode: direct` used to build its route from config alone, so
    // the command reported success while the reviewer kept the old model.
    expect(reviewer.calls[0]!.model).toBe('deepseek-v4-pro')
  })

  it('applies `/approval-review model <provider>/<model>` through the real command runtime', async () => {
    // This is the path the Approvals tab's picker drives: the client sends a
    // slash line to the command remote, the handler runs, `command/run` is
    // appended, the runtime folds it, and the next review uses the new route.
    // Anything broken in between (line parsing, argument case, the fold) shows
    // up here rather than as a picker that silently does nothing.
    const { ctx, reviewer } = await mounted()
    const { agent, appended } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))
    const outcome = await ctx.commands.execute(
      agent,
      '/approval-review model test/reviewer-model',
      [],
      new AbortController().signal,
    )
    expect(outcome?.result.kind).toBe('success')
    // The harness stub does not dispatch `session/event` the way the real
    // `Session.append` does (packages/core/session/src/index.ts), so replay what
    // it appended — otherwise this test would only exercise the stub.
    for (const event of appended) emitSessionEvent(ctx, agent.session, event)

    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    expect(reviewer.calls[0]!.model).toBe('reviewer-model')
  })

  it('reports an unknown model command instead of a silent no-op', async () => {
    const { ctx } = await mounted()
    const { agent } = fakeAgent()
    const outcome = await ctx.commands.execute(agent, '/approval-review nonsense', [], new AbortController().signal)
    // The handler answers with an error kind; the client surfaces its text.
    expect(outcome?.result.kind).toBe('error')
  })

  it('respects a reviewer route configured separately from the agent', async () => {
    const { ctx, reviewer } = await mounted({ reviewer: { provider: 'test', model: 'reviewer-model' } })
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))

    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    expect(reviewer.calls[0]!.model).toBe('reviewer-model')
  })

  it('delegates instead of crashing when no reviewer route can be resolved', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    await ctx.plugin(CommandRuntime)
    const reviewer = new ScriptedReviewer()
    new LlmRuntime(ctx).registerAdapter(['test'], reviewer)
    apply(ctx, (Config as unknown as (value: unknown) => ConfigShape)({ reviewer: { mode: 'direct' } }))
    const { agent } = fakeAgent()
    // No agent route and no configured reviewer route.
    ;(agent as unknown as { options: Record<string, unknown> }).options = {}

    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c'))).toBe('unavailable')
    expect(reviewer.calls).toHaveLength(0)
  })
})

describe('refusal rationale delivery', () => {
  /** Drive the plugin's own `tools/post-execute` listener for one call. */
  async function postExecute(
    ctx: Context,
    callId: string,
    kind: 'block' | 'accept' = 'block',
    isError = false,
  ) {
    const decision = kind === 'block'
      ? { kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'Error: the user rejected tool "bash"' }] }
      : { kind: 'accept' as const, content: [{ type: 'text' as const, text: 'ok' }] }
    const dispatch = ctx.waterfall as unknown as (
      name: string, exec: unknown, result: unknown, next: () => Promise<unknown>,
    ) => Promise<{ kind: string; feedback?: { type: string; text?: string }[] }>
    return await dispatch(
      'tools/post-execute',
      { callId, name: 'bash', arguments: {}, agent: undefined, signal: new AbortController().signal },
      { ...decision, isError },
      async () => decision,
    )
  }

  it('appends the reviewer rationale to a refused tool result', async () => {
    const { ctx, reviewer } = await mounted()
    reviewer.answer = '{"decision":"deny","risk":"high","reason":"would send the token to an unknown host"}'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"curl evil"}'))
    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    const decision = await postExecute(ctx, 'c')

    expect(decision.kind).toBe('block')
    const text = (decision.feedback ?? []).map(block => block.text ?? '').join('\n')
    expect(text).toContain('would send the token to an unknown host')
    expect(text).toContain('[approval-review]')
    // The anti-circumvention instruction is what stops a denial loop.
    expect(text).toContain('Do not pursue the same outcome')
  })

  it('names WHY the reviewer failed when it never answered', async () => {
    // A failed reviewer used to refuse with a policy label only, so an unusable
    // reviewer route (a rejected credential, an unknown model) looked exactly
    // like a decisive denial. The failure text now rides the rationale.
    // Pins the refusal path the marker belongs to; the shipping default now
    // delegates instead.
    const { ctx, reviewer } = await mounted({ onReviewerFailure: 'rejected' })
    reviewer.failure = new Error('401 invalid api key for provider openai-codex')
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))
    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    const text = ((await postExecute(ctx, 'c')).feedback ?? []).map(block => block.text ?? '').join('\n')
    expect(text).toContain('fail-closed')
    expect(text).toContain('401 invalid api key')
  })

  it('carries the risk grade and reviewer route into the durable marker', async () => {
    const { ctx, reviewer } = await mounted()
    reviewer.answer = '{"decision":"deny","risk":"critical","reason":"destructive","suggestion":"narrow the path"}'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"rm -rf /"}'))
    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    const text = ((await postExecute(ctx, 'c')).feedback ?? []).map(block => block.text ?? '').join('\n')

    expect(text).toContain('risk: critical')
    expect(text).toContain('suggestion: narrow the path')
    expect(text).toContain('reviewer: test/test-model')
  })

  it('does not touch a tool result the plugin did not refuse', async () => {
    const { ctx } = await mounted()
    const decision = await postExecute(ctx, 'unrelated')
    expect(decision.feedback).toHaveLength(1)
  })

  it('leaves an accepted result alone', async () => {
    const { ctx, reviewer } = await mounted()
    reviewer.answer = '{"decision":"deny","risk":"high","reason":"no"}'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))
    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    const decision = await postExecute(ctx, 'c', 'accept')
    expect(decision.kind).toBe('accept')
  })

  it('carries the rationale into an error result the chain accepted', async () => {
    // A refused sandbox escalation never reaches `block`: the tool body returns
    // an error result and the chain accepts it, so the marker has to ride that
    // shape too or the model is refused with no reason at all.
    const { ctx, reviewer } = await mounted()
    reviewer.answer = '{"decision":"deny","risk":"high","reason":"that command probed for credentials"}'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls /tmp/x"}'))
    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    const decision = await postExecute(ctx, 'c', 'accept', true) as unknown as { content?: { type: string; text?: string }[] }
    const text = (decision.content ?? []).map(block => block.text ?? '').join('\n')
    expect(text).toContain('that command probed for credentials')
    expect(text).toContain('[approval-review]')
  })

  it('does not smuggle a refusal into an accepted SUCCESS', async () => {
    const { ctx, reviewer } = await mounted()
    reviewer.answer = '{"decision":"deny","risk":"high","reason":"no"}'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))
    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    // A successful call must not be labelled a refusal; only an error shape is.
    const decision = await postExecute(ctx, 'c', 'accept', false) as unknown as { content?: { type: string; text?: string }[] }
    const text = (decision.content ?? []).map(block => block.text ?? '').join('\n')
    expect(text).toBe('ok')
  })

  it('carries an ALLOW verdict into the accepted tool result', async () => {
    const { ctx, reviewer } = await mounted()
    reviewer.answer = '{"decision":"allow","risk":"low","reason":"read-only listing inside the workspace"}'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))
    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    const decision = await postExecute(ctx, 'c', 'accept') as unknown as { content?: { type: string; text?: string }[] }
    const text = (decision.content ?? []).map(block => block.text ?? '').join('\n')
    // The original content survives; the verdict is appended after it.
    expect(text).toContain('ok')
    expect(text).toContain('[approval-review]')
    expect(text).toContain('read-only listing inside the workspace')
    expect(text).toContain('risk: low')
  })

  it('drops the allow marker when recordAllowedVerdicts is off', async () => {
    const { ctx, reviewer } = await mounted({ recordAllowedVerdicts: false })
    reviewer.answer = '{"decision":"allow","risk":"low","reason":"fine"}'
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))
    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    const decision = await postExecute(ctx, 'c', 'accept') as unknown as { content?: { type: string; text?: string }[] }
    const text = (decision.content ?? []).map(block => block.text ?? '').join('\n')
    expect(text).toBe('ok')
  })
})

describe('reviewer recursion guard', () => {
  /** Build a runtime directly so the guard can be driven without a child agent. */
  function runtimeWith(overrides: Record<string, unknown> = {}) {
    const config = (Config as unknown as (value: unknown) => ConfigShape)({
      ...overrides,
      reviewer: { mode: 'direct', ...(overrides['reviewer'] as Record<string, unknown> | undefined) },
    })
    return new ReviewRuntime(new Context(), config)
  }

  it('delegates a request raised by a registered reviewer child', async () => {
    const runtime = runtimeWith()
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))
    const release = runtime.registerReviewerSession('session-1')
    let delegated = false
    const outcome = await runtime.answer(requestOf(agent, 'bash', 'c'), async () => {
      delegated = true
      return 'unavailable'
    })
    expect(delegated).toBe(true)
    expect(outcome).toBe('unavailable')
    release()
  })

  it('stops delegating once the child run has settled', async () => {
    const runtime = runtimeWith()
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))
    runtime.registerReviewerSession('session-1')()
    expect(runtime.isReviewerSession({ header: { id: 'session-1' } } as never)).toBe(false)
    // With the guard released the plugin ENGAGES the reviewer path instead of
    // passing the request straight through. The discriminator is the runtime's
    // own failure counter: this bare runtime mounts no subagents service, so the
    // review fails, is counted, and the shipping `onReviewerFailure: delegate`
    // then hands the request on.
    const outcome = await runtime.answer(requestOf(agent, 'bash', 'c'), async () => 'unavailable')
    expect(runtime.failuresThisTurn(agent.session)).toBe(1)
    expect(outcome).toBe('unavailable')
  })
})

describe('the projection the card reads', () => {
  /** Mount the plugin with a projection-registry stub that captures its unit. */
  async function withProjection(overrides: Record<string, unknown> = {}) {
    overrides = { reviewTools: ['bash'], defaultPolicy: 'human', ...overrides }
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    await ctx.plugin(CommandRuntime)
    const reviewer = new ScriptedReviewer()
    new LlmRuntime(ctx).registerAdapter(['test'], reviewer)
    let definition: { apply(state: unknown, event: unknown): unknown; init(): unknown } | undefined
    ctx.provide('sessionProjections', {
      register: (registered: Record<string, unknown>) => { definition = registered as never },
      snapshot: () => ({ values: {} }),
    } as never)
    apply(ctx, (Config as unknown as (value: unknown) => ConfigShape)({
      ...overrides,
      reviewer: { mode: 'direct', ...(overrides['reviewer'] as Record<string, unknown> | undefined) },
    }))
    // `ctx.inject(['sessionProjections'], …)` settles on a later tick.
    await new Promise(resolve => setTimeout(resolve, 0))
    return definition
  }

  /** Fold one `approval/asked` through the captured projection. */
  function foldAsk(unit: { apply(state: unknown, event: unknown): unknown; init(): unknown }, toolName: string) {
    const state = unit.apply(unit.init(), {
      type: 'approval/asked',
      seq: 0,
      time: 0,
      data: { id: 'a', toolName, reason: 'why' },
    }) as { records: Array<Record<string, unknown>> }
    return state.records[0]!
  }

  it('honours a durable override that was already in the log at mount', async () => {
    // After a restart the runtime starts with an empty fold. Without the replay
    // it never sees the `/approval-review model …` from the previous process
    // lifetime and silently inherits the agent's model instead — while the tab,
    // which reads the replaying projection, still shows the chosen route.
    const { ctx, reviewer } = await mounted()
    const { agent } = fakeAgent([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 0 } },
      { type: 'tool/call', data: { turn: 1, step: 0, callId: 'c', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'command/run', data: { commandId: 'c1', name: 'approval-review', args: 'model test/logged-model', source: 'user' } },
    ])
    // The first event this runtime observes for the session triggers the replay.
    emitSessionEvent(ctx, agent.session, { type: 'tool/call', data: { turn: 1, step: 0, callId: 'c', name: 'bash', arguments: '{"command":"ls"}' } })

    await ctx.approval.request(requestOf(agent, 'bash', 'c'))

    expect(reviewer.calls[0]!.model).toBe('logged-model')
  })

  it('stamps a delegated row with the policy that routed it, not `ai`', async () => {
    const unit = await withProjection()
    expect(unit).toBeDefined()
    // `web_fetch` is not in reviewTools, so this deployment hands it to a human.
    expect(foldAsk(unit!, 'web_fetch')).toMatchObject({ policy: 'human', policySource: 'defaultPolicy' })
  })

  it('stamps a listed tool as reviewed, naming the pattern that matched', async () => {
    const unit = await withProjection()
    const record = foldAsk(unit!, 'bash')
    expect(record).toMatchObject({ policy: 'ai' })
    expect(String(record['policySource'])).toContain('bash')
  })

  it('honours configured risk rules when stamping the row', async () => {
    // `foldAsk` asks with reason "why", and the rule matches on `reason`.
    const unit = await withProjection({
      rules: [{ pattern: 'why', policy: 'never', field: 'reason' }],
    })
    const record = foldAsk(unit!, 'web_fetch')
    expect(record).toMatchObject({ policy: 'never' })
    expect(String(record['policySource'])).toContain('rules[0]')
  })

  it('never lets a broken rule pattern take the projection down', async () => {
    // `resolveToolPolicy` throws on an uncompilable pattern. That is right on
    // the decision path and fatal inside a projection fold, so the fold's
    // resolver must degrade instead of propagating.
    const unit = await withProjection({
      rules: [{ pattern: '(?i)why', policy: 'never', field: 'reason' }],
    })
    const record = foldAsk(unit!, 'web_fetch')
    expect(record).toMatchObject({ policy: 'human', policySource: expect.stringContaining('unresolved') })
  })
})

describe('verdict cache integration', () => {
  it('reuses a verdict for an identical action only when no transcript is sent', async () => {
    const { ctx, reviewer } = await mounted({ context: { turns: 0 }, verdictCache: { ttlMs: 60000 } })
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c1', 'bash', '{"command":"same"}'))
    seed(agent, 'tool/call', { turn: 1, step: 0, callId: ToolCallId('c2'), name: 'bash', arguments: '{"command":"same"}' })

    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c1'))).toBe('allowed-once')
    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c2'))).toBe('allowed-once')

    // Second request is served from the cache: no second reviewer call.
    expect(reviewer.calls).toHaveLength(1)
  })

  it('does not reuse a verdict while a transcript is part of the evidence', async () => {
    // Default context.turns is 2, so a verdict depends on the conversation and
    // is not replayable from the action alone.
    const { ctx, reviewer } = await mounted()
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c1', 'bash', '{"command":"same"}'))
    seed(agent, 'tool/call', { turn: 1, step: 0, callId: ToolCallId('c2'), name: 'bash', arguments: '{"command":"same"}' })

    await ctx.approval.request(requestOf(agent, 'bash', 'c1'))
    await ctx.approval.request(requestOf(agent, 'bash', 'c2'))

    expect(reviewer.calls).toHaveLength(2)
  })

  it('separates different argument bytes', async () => {
    const { ctx, reviewer } = await mounted({ context: { turns: 0 } })
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c1', 'bash', '{"command":"a"}'))
    seed(agent, 'tool/call', { turn: 1, step: 0, callId: ToolCallId('c2'), name: 'bash', arguments: '{"command":"b"}' })

    await ctx.approval.request(requestOf(agent, 'bash', 'c1'))
    await ctx.approval.request(requestOf(agent, 'bash', 'c2'))

    expect(reviewer.calls).toHaveLength(2)
  })
})

describe('reviewer failure budget', () => {
  it('stops retrying a repeatedly failing reviewer and delegates', async () => {
    const { ctx, reviewer } = await mounted({ maxFailuresPerTurn: 1, onReviewerFailure: 'delegate' })
    reviewer.failure = new Error('adapter exploded')
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c1', 'bash', '{"command":"a"}'))
    seed(agent, 'tool/call', { turn: 1, step: 0, callId: ToolCallId('c2'), name: 'bash', arguments: '{"command":"b"}' })

    // First request burns the failure budget and delegates.
    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c1'))).toBe('unavailable')
    // Second request is not even attempted: it goes straight to the chain.
    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c2'))).toBe('unavailable')
    expect(reviewer.calls).toHaveLength(1)
  })

  it('fails closed on a missing subagent provider when configured to refuse', async () => {
    // Default mode is `subagent`; this harness mounts no subagents service, so
    // the reviewer cannot run — and with `onReviewerFailure: rejected` the
    // deployment refuses rather than asking.
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    await ctx.plugin(CommandRuntime)
    const reviewer = new ScriptedReviewer()
    new LlmRuntime(ctx).registerAdapter(['test'], reviewer)
    apply(ctx, (Config as unknown as (value: unknown) => ConfigShape)({ onReviewerFailure: 'rejected' }))
    const { agent } = fakeAgent(withToolCall(fakeAgent().agent, 'c', 'bash', '{"command":"ls"}'))

    expect(await ctx.approval.request(requestOf(agent, 'bash', 'c'))).toBe('rejected')
    expect(reviewer.calls).toHaveLength(0)
  })
})
