/**
 * `dsh-approval-review` — Codex-style agent auto-approval for DeepSeek Harness.
 *
 * The plugin joins the official `approval/request` answerer chain as a claimant
 * that owns only the requests its own policy routes to a model, and delegates
 * everything else with `next()`. When it does claim one, a second, independent
 * reviewer model reads a bounded, secret-redacted evidence packet — the proposed
 * action, its arguments, the asker's reason, and a compact transcript — and
 * returns a structured verdict. Refusals are fail-closed, the reviewer's
 * rationale reaches the calling model, a per-turn rejection circuit breaker
 * matches Codex's guardian, and a one-shot `/approve` lets a human override one
 * denial.
 *
 * Every decision lands in an audit ledger the web review card renders. The
 * ledger adds NO session event type: the persistence read path refuses a log
 * containing a type outside the harness's own vocabulary unless the record is
 * marked `ignorable`, and `Session.append` cannot stamp that marker on any
 * published line — so a custom type would make the session unresumable. The
 * ledger instead folds the events the host already writes.
 *
 * Function plugin — no default export, because a stray default would make the
 * Loader drop this module's `name`/`inject`/`Config`/`apply` namespace.
 * @module dsh-approval-review
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
// Type-only service merges: `ctx.approval`, `ctx.commands`, the
// `tools/post-execute` event, and `ctx.sessionProjections` are contributed by
// these packages.
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import { Config, type Config as ConfigShape } from './config.ts'
import { auditView } from './audit.ts'
import { ReviewRuntime } from './runtime.ts'

export const name = 'approval-review'

/**
 * Consumers: the `/approval-review` command and the LLM seam the reviewer calls.
 * The answerer and the rationale carrier are event listeners, so they need no
 * service injection and stay mounted even if `commands` is absent.
 */
export const inject = ['commands', 'llm']

/** Re-export the schema so the Loader validates this plugin's config. */
export { Config }
export type { ConfigShape }

/** Build the default audit view for a session with no folded state yet. */
function emptyView(config: ConfigShape): ReturnType<typeof auditView> {
  return auditView(
    {
      records: [], pending: {}, arguments: {}, turn: 0, step: 0,
      reviewsThisTurn: 0, denialsStreak: 0, window: [], total: 0,
      refused: 0, nextSeq: 1, pendingOverrides: 0,
    },
    {
      enabledByDefault: config.enabledByDefault,
      maxReviewsPerTurn: config.budget.maxReviewsPerTurn,
      breakerTrips: false,
    },
  )
}

/** Register the answerer, the rationale carrier, the command, and the card feed. */
export function apply(ctx: Context, config: ConfigShape): void {
  const runtime = new ReviewRuntime(ctx, config)

  // Committed events drive both the live counters and the folded ledger. The
  // projection registry separately folds the same log for the client; this
  // observer exists for the runtime guards, which are intentionally not durable.
  ctx.on('session/event', (session: Session, event) => {
    runtime.observeEvent(session, event)
  })

  // `prepend: true` puts this answerer ahead of the human UI answerer so a
  // request the policy routes to `ai` is decided by the reviewer instead of
  // prompting. Requests it does not own still reach the human via `next()`.
  ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    return await runtime.answer(req, next)
  }, { prepend: true })

  // The refusal rationale rides the refused tool result: an approval outcome is a
  // closed vocabulary, so the tool result is the only channel that reaches the
  // model — and the only one the audit ledger can fold back for the card.
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (!config.feedReasonToModel) return await next()
    const refusal = runtime.takeRefusal(exec.callId)
    if (refusal === undefined) return await next()
    // Let the rest of the chain decide first, then append the rationale to the
    // refusal it produced: a pre-execute deny materializes as a block whose
    // feedback becomes the tool result text the model reads.
    const decision = await next()
    if (decision.kind !== 'block') return decision
    const guidance = refusal.hardStop
      ? '\nDo not pursue the same outcome through a workaround, an indirect route, or by loosening the restriction. Continue only with a materially safer alternative, or stop and ask the user.'
      : ''
    return {
      ...decision,
      feedback: [...decision.feedback, { type: 'text' as const, text: `${refusal.marker}${guidance}` }],
    }
  })

  // `/approval-review on|off|status|approve` — the durable per-session switch,
  // the live budget/breaker report, and the one-shot human override.
  ctx.commands.register({
    name: 'approval-review',
    description: 'Switch automatic approval review, inspect its ledger, or approve one denial.',
    handler: (invocation) => {
      const agent: Agent = invocation.agent
      const session = agent.session
      const args = invocation.rawInput.trim().toLowerCase()
      const action = args.split(/\s+/u)[0] ?? ''
      const zh = config.language === 'zh'
      switch (action) {
        case '':
        case 'status': {
          const view = runtime.liveView(session)
          const last = view.records.find(record => record.reason !== undefined) ?? view.records[0]
          const cache = runtime.stats()
          const lines = [
            zh
              ? `自动审批：${view.enabled ? '开启' : '关闭'}｜复核模式 ${config.reviewer.mode}${config.reviewer.mode === 'subagent' ? ` (${config.reviewer.subagentProvider})` : ''}｜模型 ${config.reviewer.model ?? '继承会话'}`
              : `Automatic approval review: ${view.enabled ? 'on' : 'off'} | reviewer ${config.reviewer.mode}${config.reviewer.mode === 'subagent' ? ` (${config.reviewer.subagentProvider})` : ''} | model ${config.reviewer.model ?? 'inherit session'}`,
            zh
              ? `本回合：复审 ${view.reviewsThisTurn}/${view.maxReviewsPerTurn}｜复核失败 ${runtime.failuresThisTurn(session)}/${config.maxFailuresPerTurn}｜连续否决 ${view.consecutiveDenials}`
              : `This turn: reviews ${view.reviewsThisTurn}/${view.maxReviewsPerTurn} | reviewer failures ${runtime.failuresThisTurn(session)}/${config.maxFailuresPerTurn} | consecutive denials ${view.consecutiveDenials}`,
            zh
              ? `累计审批 ${view.total} 次，否决 ${view.refused} 次｜熔断${view.circuitOpen ? '已触发' : '未触发'}｜可用一次性放行 ${view.pendingOverrides}`
              : `Approvals ${view.total}, refusals ${view.refused} | breaker ${view.circuitOpen ? 'open' : 'closed'} | pending overrides ${view.pendingOverrides}`,
            cache.usable
              ? (zh
                ? `裁决缓存：命中 ${cache.hits}｜未命中 ${cache.misses}｜在存 ${cache.size}`
                : `Verdict cache: hits ${cache.hits} | misses ${cache.misses} | live ${cache.size}`)
              : (zh
                ? `裁决缓存：未启用（context.turns=${config.context.turns}；只有 0 时才可安全复用裁决）`
                : `Verdict cache: disabled (context.turns=${config.context.turns}; only 0 makes a verdict replayable)`),
            last === undefined
              ? (zh ? '最近一次审批：无记录' : 'Most recent approval: none recorded')
              : (zh
                ? `最近：${last.toolName} → ${last.refused ? '否决' : '放行'}｜${last.reason ?? '（无理由记录）'}`
                : `Most recent: ${last.toolName} -> ${last.refused ? 'refused' : 'allowed'} | ${last.reason ?? '(no rationale recorded)'}`),
          ]
          return { kind: 'success' as const, text: lines.join('\n') }
        }
        case 'on':
        case 'off':
          // The durable record is the command/run event itself: the projection
          // fold replays it, so no extra storage and no custom event type.
          return {
            kind: 'success' as const,
            text: zh
              ? `自动审批已${action === 'on' ? '开启' : '关闭'}（本会话生效，重启后仍保留）`
              : `Automatic approval review turned ${action} for this session (durable across resume).`,
          }
        case 'approve': {
          const index = Number.parseInt(args.split(/\s+/u)[1] ?? '1', 10)
          const wanted = Number.isSafeInteger(index) && index > 0 ? index : 1
          const denials = runtime.liveView(session).records.filter(record => record.refused)
          const target = denials[wanted - 1]
          if (target === undefined) {
            return {
              kind: 'error' as const,
              text: zh
                ? `没有第 ${wanted} 条被否决的记录可供放行（当前 ${denials.length} 条）。`
                : `No denial number ${wanted} to approve (${denials.length} recorded).`,
            }
          }
          if (target.toolName === undefined) {
            return { kind: 'error' as const, text: zh ? '该记录缺少工具名，无法放行。' : 'That record has no tool name; cannot approve.' }
          }
          runtime.recordOverride(session, { toolName: target.toolName, at: Date.now(), reviewId: target.reviewId })
          return {
            kind: 'success' as const,
            text: zh
              ? `已记录一次性放行：下一次对 ${target.toolName} 的复审会带着这条人工授权，但复核模型仍会独立裁决。`
              : `One-shot approval recorded for ${target.toolName}: the next review of that tool carries this human authorization, but the reviewer still decides independently.`,
          }
        }
        default:
          return {
            kind: 'error' as const,
            text: zh
              ? '用法：/approval-review on|off|status|approve [n]'
              : 'Usage: /approval-review on|off|status|approve [n]',
          }
      }
    },
  })

  // The audit card's data feed. Optional: a host without the projection
  // registry still gets the answerer, just no card.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    // `wire` is what makes this key client-visible, so the view travels to the
    // browser and the fold state is still plain JSON for the projection cache.
    projectionCtx.sessionProjections.register({ ...runtime.projection() })
  })
  ctx.logger('dsh-approval-review').info(
    `automatic approval review ready (reviewTools: ${config.reviewTools.join(', ') || 'none'}, default: ${config.defaultPolicy})`,
  )
}

/** Exported for tests: the empty view shape the card falls back to. */
export { emptyView }
