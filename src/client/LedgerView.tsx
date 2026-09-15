/**
 * The approval ledger as a full conversation tab.
 *
 * This is the "look at everything that was reviewed" surface: one row per
 * approval request with the action, the verdict, the reviewer's full rationale,
 * the safer alternative it suggested, the risk grade, which rule routed it, the
 * reviewer route and timing, and the expandable arguments. The header card is the
 * at-a-glance control; this tab is the audit record.
 *
 * It reads the same `approvalReview` projection as the card, so the two can never
 * disagree, and it holds no state of its own.
 * @module dsh-approval-review/client/LedgerView
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ClientAuditRecord, ClientAuditView, ClientRisk } from './types.ts'
import { resetScrollableAncestorToTop } from './scroll.ts'

/** Props for the ledger tab. */
export interface LedgerViewProps {
  /** The session's audit ledger, or undefined before the first frame lands. */
  readonly view: ClientAuditView | undefined
  /** Whether to render copy in Chinese. */
  readonly zh: boolean
  /** Runs one slash command line in this session. */
  readonly runCommand?: (line: string) => void
  /**
   * Reviewer routes this deployment offers, as `provider/model`, in pick order.
   * Empty means this host publishes no model list, and the picker falls back to
   * a free-text id.
   */
  readonly modelChoices?: readonly string[]
  /**
   * Loads the locally configured routes on first use. Called when the picker
   * opens, so the catalog is only fetched when someone actually picks a model.
   */
  readonly loadModels?: () => Promise<readonly string[]>
}

const TEXT = 'var(--dsw-alias-label-primary, #e6edf3)'
const MUTED = 'var(--dsw-alias-label-tertiary, #8b949e)'
const BORDER = 'var(--dsw-alias-border-l2, #30363d)'
const PANEL = 'var(--dsw-alias-bg-layer-2, #161b22)'
const ROW = 'var(--dsw-alias-bg-layer-1, #0d1117)'
const ALLOWED = 'var(--dsw-alias-state-success-primary, #2ea043)'
const REFUSED = 'var(--dsw-alias-state-error-primary, #f85149)'
const WARN = 'var(--dsw-alias-state-warn-primary, #d29922)'
const CODE = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** Risk tone; unknown risk is neutral rather than reassuring. */
function riskTone(risk: ClientRisk | undefined): string {
  if (risk === 'low') return ALLOWED
  if (risk === 'medium') return WARN
  if (risk === 'high' || risk === 'critical') return REFUSED
  return MUTED
}

/**
 * Whether the plugin was even responsible for one row, from the policy that
 * routed it. A `human` or `never` row sits on the card because the user asked
 * for a record of every approval, NOT because a reviewer judged it.
 */
function routingTag(record: ClientAuditRecord, zh: boolean): string | undefined {
  if (record.policy === 'never') return zh ? '硬禁用' : 'hard-disabled'
  if (record.policy === 'human') return zh ? '交还人工' : 'delegated'
  return undefined
}

/**
 * The rationale line, told truthfully.
 *
 * A missing rationale has three very different causes and the row must not
 * blame the wrong one: a `never` row never ran a reviewer, a `human` row was
 * handed back to the human answerer, and an `ai` row either never reached the
 * reviewer or completed with the allow rationale left unpersisted
 * (`recordAllowedVerdicts: false`, or a value-projection accept).
 */
function rationaleText(record: ClientAuditRecord, zh: boolean): string {
  if (record.reason !== undefined) return record.reason
  if (record.policy === 'never') {
    return zh
      ? '按 never 策略硬禁用，没有经过复核模型。'
      : 'Hard-disabled by the never policy; no reviewer ran.'
  }
  if (record.policy === 'human') {
    return zh
      ? '已交还人工应答者，本插件没有裁决这一次。'
      : 'Delegated to the human answerer; this plugin did not decide it.'
  }
  return record.refused
    ? (zh ? '被否决，但本行没有留下理由记录。' : 'Refused, but no rationale was recorded.')
    : (zh
      ? '已放行；本行没有留下理由记录（该请求未走到复核模型，或核可理由未落盘）。'
      : 'Allowed, but no rationale was recorded (the request never reached the reviewer, or its allow rationale was not persisted).')
}


/** Short wall-clock stamp. */
function stamp(epochMs: number): string {
  const d = new Date(epochMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** A labelled field row. */
function Field({ label, children, mono }: {
  label: string
  children: React.ReactNode
  mono?: boolean
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span style={{ color: MUTED, flex: '0 0 auto', width: 76, fontSize: 11 }}>{label}</span>
      <span style={{
        color: TEXT,
        fontSize: mono === true ? 11 : 12,
        fontFamily: mono === true ? CODE : undefined,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        flex: '1 1 auto',
      }}>{children}</span>
    </div>
  )
}

/** Identifies the picker's option list; one Approvals tab renders per session. */
const MODEL_CHOICES_ID = 'approval-review-model-choices'

/** Merge the base list with the loaded catalog, keeping the base order first. */
function reviewerRoutesMerge(base: readonly string[], loaded: readonly string[]): readonly string[] {
  const out = [...base]
  for (const route of loaded) if (!out.includes(route)) out.push(route)
  return out
}

/** One ledger entry, expanded. */
function Entry({ record, zh, onApprove, deniedIndex }: {
  record: ClientAuditRecord
  zh: boolean
  onApprove?: (record: ClientAuditRecord, denialIndex: number) => void
  deniedIndex: number
}): React.JSX.Element {
  const [showArgs, setShowArgs] = useState(false)
  const pending = record.outcome === undefined
  const verdict = pending
    ? (zh ? '进行中' : 'pending')
    : record.refused
      ? (zh ? '否决' : 'refused')
      : record.outcome === 'allowed-once' ? (zh ? '放行' : 'allowed') : (zh ? '转人工' : 'delegated')
  const tone = pending ? MUTED : record.refused ? REFUSED : ALLOWED

  return (
    <div style={{
      border: `1px solid ${BORDER}`,
      borderLeft: `3px solid ${tone}`,
      borderRadius: 8,
      background: ROW,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: CODE, fontSize: 13, fontWeight: 600, color: TEXT }}>{record.toolName}</span>
        <span style={{ fontSize: 11, color: tone, border: `1px solid ${tone}`, borderRadius: 999, padding: '1px 7px' }}>{verdict}</span>
        {routingTag(record, zh) === undefined ? null : (
          <span style={{ fontSize: 11, color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 999, padding: '1px 7px' }}>
            {routingTag(record, zh)}
          </span>
        )}
        {record.risk === undefined ? null : (
          <span style={{ fontSize: 11, color: riskTone(record.risk) }}>{zh ? '风险' : 'risk'} {record.risk}</span>
        )}
        {record.overridden ? <span style={{ fontSize: 11, color: WARN }}>{zh ? '含人工一次性授权' : 'human override'}</span> : null}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: MUTED }}>
          {stamp(record.startedAt)} · T{record.turn}/S{record.step}
          {record.durationMs === undefined ? '' : ` · ${record.durationMs} ms`}
        </span>
      </div>

      <Field label={zh ? '裁决理由' : 'rationale'}>
        <span style={{ color: record.reason === undefined ? MUTED : TEXT }}>{rationaleText(record, zh)}</span>
      </Field>

      {record.suggestion === undefined ? null : (
        <Field label={zh ? '更安全的做法' : 'safer path'}>{record.suggestion}</Field>
      )}
      <Field label={zh ? '路由策略' : 'routing'} mono>{record.policy} · {record.policySource}</Field>
      {record.askReason === undefined ? null : (
        <Field label={zh ? '申请理由' : 'asked why'}>{record.askReason}</Field>
      )}
      {record.reviewerRoute === undefined ? null : (
        <Field label={zh ? '复核模型' : 'reviewer'} mono>
          {record.reviewerRoute}{record.uncertain ? ` · ${zh ? '不确定' : 'uncertain'}` : ''}
        </Field>
      )}

      {record.argumentsPreview === undefined ? null : (
        <div>
          <button
            type="button"
            onClick={() => setShowArgs(v => !v)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--dsw-alias-link, #58a6ff)', fontSize: 11 }}
          >{showArgs ? (zh ? '收起参数' : 'hide arguments') : (zh ? '查看参数' : 'show arguments')}</button>
          {showArgs ? (
            <pre style={{
              margin: '6px 0 0', padding: 10, borderRadius: 6, background: PANEL,
              fontFamily: CODE, fontSize: 11, color: TEXT, whiteSpace: 'pre-wrap',
              wordBreak: 'break-word', maxHeight: 320, overflow: 'auto',
            }}>{record.argumentsPreview}</pre>
          ) : null}
        </div>
      )}

      {record.refused && record.outcome === 'rejected' && onApprove !== undefined ? (
        <button
          type="button"
          onClick={() => onApprove(record, deniedIndex)}
          style={{
            alignSelf: 'flex-start', cursor: 'pointer', fontSize: 11, padding: '3px 9px',
            borderRadius: 6, border: `1px solid ${BORDER}`, background: 'transparent', color: TEXT,
          }}
        >{zh ? `授权重试第 ${deniedIndex} 条否决` : `approve denial #${deniedIndex} for one retry`}</button>
      ) : null}
    </div>
  )
}

/** The full ledger tab. */
/**
 * Start a freshly opened ledger at its top.
 *
 * The tab renders inside the conversation's resident scrollport, which the
 * transcript keeps pinned to its newest line, so a ledger mounted under it would
 * show its own BOTTOM — while the ledger lists the newest decision FIRST. The
 * walk that finds the box to reset lives in `./scroll.ts`.
 * @param root - the ledger's root element.
 */
function useStartAtTop(root: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const element = root.current
    if (element === null) return
    // Our own container first: it is the scroller whenever the height chain
    // reaches it, and a fresh mount already starts at zero there.
    element.scrollTop = 0
    if (typeof window === 'undefined') return
    resetScrollableAncestorToTop(element, node => window.getComputedStyle(node).overflowY)
  }, [root])
}

export function LedgerView({ view, zh, runCommand, modelChoices, loadModels }: LedgerViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  useStartAtTop(rootRef)
  const [modelDraft, setModelDraft] = useState('')
  const [loadedChoices, setLoadedChoices] = useState<readonly string[] | undefined>(undefined)
  // The base list (override in force + session model) paints immediately; the
  // catalog replaces it once loaded, so the control is never empty in between.
  const choices = loadedChoices ?? modelChoices ?? []
  const loadOnce = (): void => {
    if (loadedChoices !== undefined || loadModels === undefined) return
    void loadModels().then((routes) => {
      setLoadedChoices(routes.length === 0 ? (modelChoices ?? []) : reviewerRoutesMerge(modelChoices ?? [], routes))
    }).catch(() => { setLoadedChoices(modelChoices ?? []) })
  }
  const records = view?.records ?? []
  const denials = useMemo(() => records.filter(r => r.refused), [records])
  const reviewedCount = useMemo(() => records.filter(r => r.policy === 'ai').length, [records])
  const deniedIndexOf = (record: ClientAuditRecord): number =>
    denials.findIndex(d => d.reviewId === record.reviewId) + 1

  const headerStyle: CSSProperties = {
    display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
    padding: '0 2px 10px', borderBottom: `1px solid ${BORDER}`, marginBottom: 12,
  }

  return (
    <div ref={rootRef} style={{ padding: '14px 16px', overflow: 'auto', height: '100%', fontFamily: 'inherit' }}>
      <div style={headerStyle}>
        <strong style={{ fontSize: 14, color: TEXT }}>{zh ? '审批审计' : 'Approval audit'}</strong>
        <span style={{ fontSize: 12, color: view?.enabled === false ? MUTED : ALLOWED }}>
          {view === undefined ? (zh ? '尚无数据' : 'no data') : view.enabled ? (zh ? '自动审批已开启' : 'auto-approval on') : (zh ? '自动审批已关闭' : 'auto-approval off')}
        </span>
        {runCommand === undefined ? null : (
          <>
            <button type="button" disabled={view?.enabled === true} onClick={() => runCommand('/approval-review on')}
              style={{ fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: view?.enabled === true ? 'default' : 'pointer', border: `1px solid ${BORDER}`, color: view?.enabled === true ? MUTED : TEXT, background: 'transparent' }}>
              {zh ? '开启' : 'on'}
            </button>
            <button type="button" disabled={view?.enabled === false} onClick={() => runCommand('/approval-review off')}
              style={{ fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: view?.enabled === false ? 'default' : 'pointer', border: `1px solid ${BORDER}`, color: view?.enabled === false ? MUTED : TEXT, background: 'transparent' }}>
              {zh ? '关闭' : 'off'}
            </button>
          </>
        )}
        {view === undefined ? null : (
          <span style={{ fontSize: 11, color: MUTED, fontFamily: CODE }}>
            {zh ? '复核模型 ' : 'reviewer '}
            {view.reviewerModel.length > 0
              ? `${view.reviewerProvider.length > 0 ? `${view.reviewerProvider}/` : ''}${view.reviewerModel}`
              : (zh ? '继承会话' : 'inherit session')}
          </span>
        )}
        {runCommand === undefined ? null : (
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {/* A datalist input, not a <select>: clicking it lists every model
                the deployment configures locally, while still allowing an id the
                catalog does not advertise (catalog membership is advisory). */}
            <input
              list={MODEL_CHOICES_ID}
              value={modelDraft}
              onFocus={loadOnce}
              onMouseDown={loadOnce}
              onChange={event => setModelDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || modelDraft.trim().length === 0) return
                runCommand(`/approval-review model ${modelDraft.trim()}`)
                setModelDraft('')
              }}
              placeholder={zh ? '选择或输入模型' : 'pick or type a model'}
              aria-label={zh ? '复核模型' : 'reviewer model'}
              style={{
                fontFamily: CODE, fontSize: 11, padding: '2px 6px', width: 210,
                borderRadius: 6, border: `1px solid ${BORDER}`, background: 'transparent', color: TEXT,
              }}
            />
            <datalist id={MODEL_CHOICES_ID}>
              {choices.map(choice => <option key={choice} value={choice} />)}
            </datalist>
            <button
              type="button"
              disabled={modelDraft.trim().length === 0}
              onClick={() => {
                runCommand(`/approval-review model ${modelDraft.trim()}`)
                setModelDraft('')
              }}
              style={{
                fontSize: 11, padding: '3px 9px', borderRadius: 6,
                cursor: modelDraft.trim().length === 0 ? 'default' : 'pointer',
                border: `1px solid ${BORDER}`,
                color: modelDraft.trim().length === 0 ? MUTED : TEXT,
                background: 'transparent',
              }}
            >{zh ? '应用' : 'apply'}</button>
            <button
              type="button"
              onClick={() => runCommand('/approval-review model default')}
              style={{ fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: 'pointer', border: `1px solid ${BORDER}`, color: TEXT, background: 'transparent' }}
            >{zh ? '继承' : 'inherit'}</button>
          </span>
        )}
        {view === undefined || view.total === 0 ? null : (
          <span style={{ fontSize: 11, color: MUTED }}>
            {zh
              ? `共 ${view.total} 次 · 本插件裁决 ${reviewedCount} · 已否决 ${view.refused} · 本回合复审 ${view.reviewsThisTurn}/${view.maxReviewsPerTurn} · 连续否决 ${view.consecutiveDenials}`
              : `${view.total} total · ${reviewedCount} routed to the reviewer · ${view.refused} refused · this turn ${view.reviewsThisTurn}/${view.maxReviewsPerTurn} · streak ${view.consecutiveDenials}`}
          </span>
        )}
      </div>

      {view?.circuitOpen === true ? (
        <div style={{ fontSize: 12, color: REFUSED, marginBottom: 10 }}>
          {zh ? '否决熔断已触发：本回合后续请求转人工审批。' : 'Rejection breaker is open: later requests in this turn go to the human chain.'}
        </div>
      ) : null}

      {records.length === 0 ? (
        <div style={{ fontSize: 13, color: MUTED, padding: '24px 4px', lineHeight: 1.7 }}>
          {zh
            ? '本会话还没有审批记录。当某个动作需要越过沙箱边界时，这里会留下完整的裁决理由、风险等级与更安全的替代做法。'
            : 'No approvals recorded in this session yet. When an action needs to cross the sandbox boundary, its full rationale, risk grade, and safer alternative land here.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {records.map(record => (
            <Entry
              key={record.reviewId}
              record={record}
              zh={zh}
              deniedIndex={deniedIndexOf(record)}
              onApprove={runCommand === undefined
                ? undefined
                : (_r, index) => runCommand(`/approval-review approve ${index}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
