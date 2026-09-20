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
import { Config, validateReviewerEngine, type Config as ConfigShape } from './config.ts'
import { readCredentialSeam } from './jev-key.ts'
import { auditView } from './audit.ts'
import { ReviewRuntime } from './runtime.ts'
import { outputIsZh } from './output-language.ts'

/** The command handler's language read; also the output-language tests' entry point. */
export { outputIsZh }

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

/**
 * Reviewer route label the card and the status command show. Engine-aware: the
 * Jev engine's route is the TypeSafe side, and reporting an inherited LLM route
 * there would name a model that never sees the request.
 */
function reviewerLabels(config: ConfigShape): { readonly provider: string; readonly model: string } {
  return config.reviewer.engine === 'jev'
    ? { provider: 'typesafe', model: config.reviewer.jev.model }
    : { provider: config.reviewer.provider ?? '', model: config.reviewer.model ?? '' }
}

/** Whether the configured environment variable currently holds a non-empty value. */
function reviewerKeyInEnvironment(config: ConfigShape): boolean {
  return (process.env[config.reviewer.jev.apiKeyEnv] ?? '').trim().length > 0
}

/**
 * Whether the Jev key is PROVABLY missing: absent from the process environment
 * and no credential seam is mounted that could hold it.
 *
 * Deliberately conservative. A mounted credential service resolves its own layers
 * (launch environment, managed store, project and harness-home `.env`) and does so
 * asynchronously while `apply` is synchronous — claiming "missing" there would be
 * a false alarm on exactly the deployment shape this plugin recommends. A key that
 * really is unreachable still surfaces as a precise failure on the first review,
 * which follows `onReviewerFailure`.
 * @param ctx - the mounting context, read for the credential seam.
 * @param config - validated plugin configuration.
 * @returns true only when no source could possibly provide the key.
 */
function jevKeyProvablyMissing(ctx: Context, config: ConfigShape): boolean {
  if (reviewerKeyInEnvironment(config)) return false
  return readCredentialSeam(ctx.get('credentials')) === undefined
}

/** Build the default audit view for a session with no folded state yet. */
function emptyView(config: ConfigShape): ReturnType<typeof auditView> {
  const labels = reviewerLabels(config)
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
      defaultReviewerModel: labels.model,
      defaultReviewerProvider: labels.provider,
      defaultReviewerEngine: config.reviewer.engine,
      defaultJevPermitted: config.reviewer.jev.allowEgress,
    },
  )
}

/** Register the answerer, the rationale carrier, the command, and the card feed. */
export function apply(ctx: Context, config: ConfigShape): void {
  // Engine misconfiguration fails the mount instead of surfacing on the first
  // approval: an unusable reviewer that silently hands work to the human chain
  // looks like a policy decision, which is exactly the wrong signal.
  const problems = validateReviewerEngine(config)
  for (const warning of problems.warnings) ctx.logger('dsh-approval-review').warn(warning)
  if (problems.errors.length > 0) {
    throw new Error(`dsh-approval-review: ${problems.errors.join(' ')}`)
  }
  // The Jev key comes from the harness credential seam first (the app's credential
  // settings, `$DSH_HOME/.env`, or the launch environment) and from `process.env`
  // as the fallback. Warn at MOUNT only in the case that cannot possibly work, so
  // the startup log names the real problem instead of turning every review into a
  // silent human handoff.
  if (config.reviewer.engine === 'jev' && jevKeyProvablyMissing(ctx, config)) {
    ctx.logger('dsh-approval-review').warn(
      `reviewer.engine is "jev" but ${config.reviewer.jev.apiKeyEnv} is unset and no credential store is mounted: `
      + 'every review will report a missing credential and follow `onReviewerFailure`. Store the key through the '
      + 'harness credential settings (or `$DSH_HOME/.env`), then restart.',
    )
  }
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
  // model — and the only one the audit ledger can fold back for the card. An
  // ALLOW verdict has the same problem and takes the same channel, gated by
  // `recordAllowedVerdicts` because it costs the model one marker block.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Both are consumed unconditionally: a stashed decision belongs to exactly
    // one call, and leaving it in the map only leaks it until the next eviction.
    const refusal = runtime.takeRefusal(exec.callId)
    const allowance = runtime.takeAllowance(exec.callId)
    if (refusal === undefined && allowance === undefined) return await next()
    if (refusal !== undefined && config.feedReasonToModel) {
      // Let the rest of the chain decide first, then append the rationale to the
      // refusal it produced. Two shapes carry it, and BOTH need it:
      //  - a pre-execute deny materializes as a `block` whose feedback becomes
      //    the tool result text the model reads;
      //  - a denial raised INSIDE the tool body — a refused sandbox escalation
      //    (`sandbox_permissions`) is the common one — surfaces as an ordinary
      //    error result, which the chain accepts. Without this second shape the
      //    model is told "no" with no reason, and the ledger has none either.
      const decision = await next()
      const guidance = refusal.hardStop
        ? '\nDo not pursue the same outcome through a workaround, an indirect route, or by loosening the restriction. Continue only with a materially safer alternative, or stop and ask the user.'
        : ''
      const text = `${refusal.marker}${guidance}`
      if (decision.kind === 'block') {
        return { ...decision, feedback: [...decision.feedback, { type: 'text' as const, text }] }
      }
      if (decision.kind === 'accept' && result.isError
        && (decision as { value?: unknown }).value === undefined) {
        return {
          kind: 'accept' as const,
          content: [...result.content, { type: 'text' as const, text }],
          ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
        }
      }
      return decision
    }
    if (allowance === undefined) return await next()
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    // A value-projection accept carries an execution-local value that a content
    // replacement would drop, so that shape is left exactly as the chain
    // produced it. The verdict still reaches the log through `approval/decided`;
    // only its rationale is skipped.
    if ((decision as { value?: unknown }).value !== undefined) return decision
    return {
      kind: 'accept' as const,
      content: [...result.content, { type: 'text' as const, text: allowance.marker }],
      ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
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
      // Resolved per invocation, not at mount: a language switch applies to the
      // next command without a restart (see `outputIsZh`).
      const zh = outputIsZh(ctx, config)
      switch (action) {
        case '':
        case 'status': {
          const view = runtime.liveView(session)
          const last = view.records.find(record => record.reason !== undefined) ?? view.records[0]
          const cache = runtime.stats()
          const engineNote = [
            config.reviewer.jev.allowEgress ? '' : 'egress not acknowledged',
            view.reviewerEngine === 'jev' && jevKeyProvablyMissing(ctx, config)
              ? `${config.reviewer.jev.apiKeyEnv} missing`
              : '',
          ].filter(note => note.length > 0).join(', ')
          // The EFFECTIVE engine: a session selection from the picker may have
          // switched it, and saying "llm" while Jev answers would be a lie.
          const engine = view.reviewerEngine === 'jev'
            ? `jev (${view.reviewerModel}${engineNote.length > 0 ? `, ${engineNote}` : ''})`
            : `llm${config.reviewer.mode === 'subagent' ? `/${config.reviewer.mode}` : ''}`
          const overrideNote = view.reviewerEngine === config.reviewer.engine
            ? ''
            : (zh
              ? `｜会话覆盖（部署默认 ${config.reviewer.engine}）`
              : ` | session override (deployment: ${config.reviewer.engine})`)
          // The preset gate is the other reason a ledger stays empty while every
          // line above looks healthy: the plugin claims nothing unless the
          // session's access mode is the configured preset.
          const gate = config.reviewerPreset.length === 0
            ? (zh ? '任意访问模式' : 'any access mode')
            : (zh ? `访问模式 ${config.reviewerPreset}` : `access mode ${config.reviewerPreset}`)
          // Requests this plugin deliberately did NOT decide, with the reason code.
          // Without it, a ledger row that carries no rationale is unreadable: the
          // operator cannot tell "the reviewer never saw it" from "the reviewer
          // saw it and handed it over".
          const leftToHuman = runtime.delegationsThisTurn(session)
          const lines = [
            zh
              ? `自动审批：${view.enabled ? '开启' : '关闭'}｜复核引擎 ${engine}${overrideNote}｜门控 ${gate}｜模型 ${view.reviewerModel.length > 0 ? `${view.reviewerProvider.length > 0 ? `${view.reviewerProvider}/` : ''}${view.reviewerModel}` : '继承会话'}`
              : `Automatic approval review: ${view.enabled ? 'on' : 'off'} | engine ${engine}${overrideNote} | gate ${gate} | model ${view.reviewerModel.length > 0 ? `${view.reviewerProvider.length > 0 ? `${view.reviewerProvider}/` : ''}${view.reviewerModel}` : 'inherit session'}`,
            zh
              ? `本回合：复审 ${view.reviewsThisTurn}/${view.maxReviewsPerTurn}｜复核失败 ${runtime.failuresThisTurn(session)}/${config.maxFailuresPerTurn}｜连续否决 ${view.consecutiveDenials}`
              : `This turn: reviews ${view.reviewsThisTurn}/${view.maxReviewsPerTurn} | reviewer failures ${runtime.failuresThisTurn(session)}/${config.maxFailuresPerTurn} | consecutive denials ${view.consecutiveDenials}`,
            ...leftToHuman.length === 0 ? [] : [zh
              ? `本回合未交复核：${leftToHuman.join('｜')}`
              : `Left to the human chain this turn: ${leftToHuman.join(' | ')}`],
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
          if (!runtime.recordOverride(session, { toolName: target.toolName, at: Date.now(), reviewId: target.reviewId, ...target.callId === undefined ? {} : { callId: target.callId } })) {
            return { kind: 'error' as const, text: zh ? '无法恢复原始操作，未记录授权。' : 'Original action unavailable; no authorization recorded.' }
          }
          return {
            kind: 'success' as const,
            text: zh
              ? `已记录一次性放行：下一次对 ${target.toolName} 相同参数的复审会带着这条人工授权，但复核模型仍会独立裁决。`
              : `One-shot approval recorded for ${target.toolName}: the next review with byte-identical arguments carries this human authorization, but the reviewer still decides independently.`,
          }
        }
        case 'model': {
          // The durable record is the command/run event itself, exactly like the
          // on/off switch, so the choice survives resume without extra storage.
          const requested = args.split(/\s+/u).slice(1).join(' ').trim()
          if (requested.length === 0) {
            const current = runtime.liveView(session).reviewerModel
            return {
              kind: 'success' as const,
              text: zh
                ? `复核模型：${current.length > 0 ? current : '继承会话模型（未覆盖）'}\n用法：/approval-review model [<provider>/]<模型 id>｜model default 恢复继承`
                : `Reviewer model: ${current.length > 0 ? current : 'inherit the session model (no override)'}\nUsage: /approval-review model [<provider>/]<id> | model default to inherit again`,
            }
          }
          return {
            kind: 'success' as const,
            text: zh
              ? `复核模型已设为 ${requested}（本会话持久生效）`
              : `Reviewer model set to ${requested} for this session (durable across resume).`,
          }
        }
        default:
          return {
            kind: 'error' as const,
            text: zh
              ? '用法：/approval-review on|off|status|approve [n]|model [id]'
              : 'Usage: /approval-review on|off|status|approve [n]|model [id]',
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
