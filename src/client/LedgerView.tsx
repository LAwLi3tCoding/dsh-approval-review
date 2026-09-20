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
 *
 * Copy follows the harness's own language preference through the `t` seat (see
 * `./locale.ts`). Fields the plugin did NOT author — the reviewer's rationale,
 * the asker's reason, the arguments preview — are printed verbatim, because they
 * are transcript text recorded at decision time, not this tab's copy.
 * @module dsh-approval-review/client/LedgerView
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ClientAuditRecord, ClientAuditView, ClientRisk } from './types.ts'
import { resetScrollableAncestorToTop } from './scroll.ts'
import { reviewerModelChoices } from './model-choices.ts'
import { ModelPicker } from './ModelPicker.tsx'
import type { ApprovalReviewTranslate } from './locale.ts'

/** Props for the ledger tab. */
export interface LedgerViewProps {
  /** The session's audit ledger, or undefined before the first frame lands. */
  readonly view: ClientAuditView | undefined
  /**
   * Translate function for this plugin's copy, bound to the ACTIVE harness
   * locale. The slot seat hands out a fresh reference per language revision, so
   * a switch re-renders this tab without a subscription of our own.
   */
  readonly t: ApprovalReviewTranslate
  /**
   * Runs one slash command line in this session. A returned string is a failure
   * line the host refused, which the tab surfaces instead of swallowing.
   */
  readonly runCommand?: (line: string) => void | Promise<string | null>
  /**
   * Reviewer routes this deployment offers, as `provider/model`, in pick order.
   * Empty means this host publishes no model list, and the picker falls back to
   * a free-text id.
   */
  readonly modelChoices?: readonly string[]
  /**
   * Loads the locally configured routes on first use, with their display names.
   * Called when the picker opens, so the catalog is only fetched when someone
   * actually picks a model.
   */
  readonly loadModelRoutes?: () => Promise<{
    readonly routes: readonly string[]
    readonly labels: Readonly<Record<string, string>>
  }>
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
 * The risk grade as copy.
 *
 * The wire value is a closed ENGLISH enum (`low` …) that the reviewer reports and
 * the projection carries; only its display follows the language, which is what
 * keeps a Chinese row from reading "风险 low".
 */
function riskLabel(risk: ClientRisk, t: ApprovalReviewTranslate): string {
  if (risk === 'low') return t('riskLow')
  if (risk === 'medium') return t('riskMedium')
  if (risk === 'high') return t('riskHigh')
  return t('riskCritical')
}

/**
 * Whether the plugin was even responsible for one row, from the policy that
 * routed it. A `human` or `never` row sits on the card because the user asked
 * for a record of every approval, NOT because a reviewer judged it.
 */
function routingTag(record: ClientAuditRecord, t: ApprovalReviewTranslate): string | undefined {
  if (record.policy === 'never') return t('tagHardDisabled')
  if (record.policy === 'human') return t('tagDelegated')
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
 *
 * Only the three fallbacks are this plugin's copy; `record.reason` is the
 * reviewer's own recorded words in whatever language it answered, and it is
 * printed verbatim.
 */
function rationaleText(record: ClientAuditRecord, t: ApprovalReviewTranslate): string {
  if (record.reason !== undefined) return record.reason
  if (record.policy === 'never') return t('reasonNever')
  if (record.policy === 'human') return t('reasonHuman')
  return record.refused ? t('reasonRefusedMissing') : t('reasonAllowedMissing')
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

/** Merge the base list with the loaded catalog, keeping the base order first. */
function reviewerRoutesMerge(base: readonly string[], loaded: readonly string[]): readonly string[] {
  const out = [...base]
  for (const route of loaded) if (!out.includes(route)) out.push(route)
  return out
}

/** One ledger entry, expanded. */
function Entry({ record, t, onApprove, deniedIndex }: {
  record: ClientAuditRecord
  t: ApprovalReviewTranslate
  onApprove?: (record: ClientAuditRecord, denialIndex: number) => void
  deniedIndex: number
}): React.JSX.Element {
  const [showArgs, setShowArgs] = useState(false)
  const pending = record.outcome === undefined
  const verdict = pending
    ? t('pending')
    : record.refused
      ? t('refused')
      : record.outcome === 'allowed-once' ? t('allowed') : t('delegated')
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
        {routingTag(record, t) === undefined ? null : (
          <span style={{ fontSize: 11, color: MUTED, border: `1px solid ${BORDER}`, borderRadius: 999, padding: '1px 7px' }}>
            {routingTag(record, t)}
          </span>
        )}
        {record.risk === undefined ? null : (
          <span style={{ fontSize: 11, color: riskTone(record.risk) }}>{t('risk')} {riskLabel(record.risk, t)}</span>
        )}
        {record.userAuthorization === undefined ? null : (
          <span style={{ fontSize: 11, color: MUTED }}>{t('authorization')} {record.userAuthorization === 'unknown' ? t('authUnknown') : riskLabel(record.userAuthorization, t)}</span>
        )}
        {record.overridden ? <span style={{ fontSize: 11, color: WARN }}>{t('override')}</span> : null}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: MUTED }}>
          {stamp(record.startedAt)} · T{record.turn}/S{record.step}
          {record.durationMs === undefined ? '' : ` · ${record.durationMs} ms`}
        </span>
      </div>

      <Field label={t('rationaleLabel')}>
        <span style={{ color: record.reason === undefined ? MUTED : TEXT }}>{rationaleText(record, t)}</span>
      </Field>

      {record.suggestion === undefined ? null : (
        <Field label={t('saferPath')}>{record.suggestion}</Field>
      )}
      <Field label={t('routing')} mono>{record.policy} · {record.policySource}</Field>
      {record.askReason === undefined ? null : (
        <Field label={t('askedWhy')}>{record.askReason}</Field>
      )}
      {record.reviewerRoute === undefined ? null : (
        <Field label={t('reviewer')} mono>
          {record.reviewerRoute}{record.uncertain ? ` · ${t('uncertain')}` : ''}
        </Field>
      )}

      {record.argumentsPreview === undefined ? null : (
        <div>
          <button
            type="button"
            onClick={() => setShowArgs(v => !v)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--dsw-alias-link, #58a6ff)', fontSize: 11 }}
          >{showArgs ? t('hideArgs') : t('showArgs')}</button>
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
        >{t('approveRetry', { n: deniedIndex })}</button>
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

export function LedgerView({ view, t, runCommand, modelChoices, loadModelRoutes }: LedgerViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  useStartAtTop(rootRef)
  const [loadedChoices, setLoadedChoices] = useState<readonly string[] | undefined>(undefined)
  /** Route id → the catalog's display name, when it differs from the id. */
  const [modelLabels, setModelLabels] = useState<Readonly<Record<string, string>>>({})
  // A refused command used to look identical to a click that did nothing.
  const [commandError, setCommandError] = useState<string | null>(null)
  const run = (line: string): void => {
    if (runCommand === undefined) return
    setCommandError(null)
    void Promise.resolve(runCommand(line))
      .then((failure) => { if (typeof failure === 'string') setCommandError(failure) })
      .catch((error: unknown) => { setCommandError(String(error)) })
  }
  // The base list (override in force + session model) paints immediately; the
  // catalog replaces it once loaded, so the picker is never empty in between.
  const choices = loadedChoices ?? modelChoices ?? []
  // One list, two engines: every row is a reviewer this session can switch to, so
  // the Jev rows are offered whenever the deployment permitted Jev at all — not
  // only while Jev happens to be the engine in force. The offer never moves with
  // the current selection.
  const pickerChoices = reviewerModelChoices(view?.jevSelectable === true, choices)
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
        <strong style={{ fontSize: 14, color: TEXT }}>{t('title')}</strong>
        <span style={{ fontSize: 12, color: view?.enabled === false ? MUTED : ALLOWED }}>
          {view === undefined ? t('noData') : view.enabled ? t('autoOn') : t('autoOff')}
        </span>
        {runCommand === undefined ? null : (
          <>
            <button type="button" disabled={view?.enabled === true} onClick={() => run('/approval-review on')}
              style={{ fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: view?.enabled === true ? 'default' : 'pointer', border: `1px solid ${BORDER}`, color: view?.enabled === true ? MUTED : TEXT, background: 'transparent' }}>
              {t('enable')}
            </button>
            <button type="button" disabled={view?.enabled === false} onClick={() => run('/approval-review off')}
              style={{ fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: view?.enabled === false ? 'default' : 'pointer', border: `1px solid ${BORDER}`, color: view?.enabled === false ? MUTED : TEXT, background: 'transparent' }}>
              {t('disable')}
            </button>
          </>
        )}
        {view === undefined ? null : (
          <span style={{ fontSize: 11, color: MUTED, fontFamily: CODE }}>
            {`${t('reviewer')} `}
            {view.reviewerModel.length > 0
              ? `${view.reviewerProvider.length > 0 ? `${view.reviewerProvider}/` : ''}${view.reviewerModel}`
              : t('inheritSession')}
          </span>
        )}
        {runCommand === undefined ? null : (
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <ModelPicker
              choices={pickerChoices}
              labels={modelLabels}
              runCommand={run}
              loadModelRoutes={loadModelRoutes}
              t={t}
              onRoutesLoaded={({ routes, labels }) => {
                setModelLabels(labels)
                setLoadedChoices(routes.length === 0 ? (modelChoices ?? []) : reviewerRoutesMerge(modelChoices ?? [], routes))
              }}
            />
            <button
              type="button"
              onClick={() => run('/approval-review model default')}
              style={{ fontSize: 11, padding: '3px 9px', borderRadius: 6, cursor: 'pointer', border: `1px solid ${BORDER}`, color: TEXT, background: 'transparent' }}
            >{t('inherit')}</button>
          </span>
        )}
        {view === undefined || view.total === 0 ? null : (
          <span style={{ fontSize: 11, color: MUTED }}>
            {t('summary', {
              total: view.total,
              reviewed: reviewedCount,
              refused: view.refused,
              turn: view.reviewsThisTurn,
              max: view.maxReviewsPerTurn,
              streak: view.consecutiveDenials,
            })}
          </span>
        )}
      </div>

      {commandError === null ? null : (
        <div style={{ fontSize: 11, color: REFUSED, marginBottom: 8 }}>
          {t('commandRefused')}{commandError}
        </div>
      )}

      {view?.circuitOpen === true ? (
        <div style={{ fontSize: 12, color: REFUSED, marginBottom: 10 }}>
          {t('breaker')}
        </div>
      ) : null}

      {records.length === 0 ? (
        <div style={{ fontSize: 13, color: MUTED, padding: '24px 4px', lineHeight: 1.7 }}>
          {t('empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {records.map(record => (
            <Entry
              key={record.reviewId}
              record={record}
              t={t}
              deniedIndex={deniedIndexOf(record)}
              onApprove={runCommand === undefined
                ? undefined
                : (_r, index) => run(`/approval-review approve ${index}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
