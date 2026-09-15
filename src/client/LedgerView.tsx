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

import { useMemo, useState, type CSSProperties } from 'react'
import type { ClientAuditRecord, ClientAuditView, ClientRisk } from './types.ts'

/** Props for the ledger tab. */
export interface LedgerViewProps {
  /** The session's audit ledger, or undefined before the first frame lands. */
  readonly view: ClientAuditView | undefined
  /** Whether to render copy in Chinese. */
  readonly zh: boolean
  /** Runs one slash command line in this session. */
  readonly runCommand?: (line: string) => void
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
        {record.reason ?? (zh
          ? '（未记录：本次审批未经本插件裁决——可能由其他应答者处理，或审计写入被关闭）'
          : '(not recorded: this approval was not decided by this plugin)')}
      </Field>

      {record.suggestion === undefined ? null : (
        <Field label={zh ? '更安全的做法' : 'safer path'}>{record.suggestion}</Field>
      )}
      <Field label={zh ? '策略来源' : 'policy'} mono>{record.policy} · {record.policySource}</Field>
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
export function LedgerView({ view, zh, runCommand }: LedgerViewProps): React.JSX.Element {
  const records = view?.records ?? []
  const denials = useMemo(() => records.filter(r => r.refused), [records])
  const deniedIndexOf = (record: ClientAuditRecord): number =>
    denials.findIndex(d => d.reviewId === record.reviewId) + 1

  const headerStyle: CSSProperties = {
    display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
    padding: '0 2px 10px', borderBottom: `1px solid ${BORDER}`, marginBottom: 12,
  }

  return (
    <div style={{ padding: '14px 16px', overflow: 'auto', height: '100%', fontFamily: 'inherit' }}>
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
            {zh ? '复核模型 ' : 'reviewer '}{view.reviewerModel.length > 0 ? view.reviewerModel : (zh ? '继承会话' : 'inherit session')}
          </span>
        )}
        {view === undefined || view.total === 0 ? null : (
          <span style={{ fontSize: 11, color: MUTED }}>
            {zh
              ? `共 ${view.total} 次 · 放行 ${view.total - view.refused} · 否决 ${view.refused} · 本回合复审 ${view.reviewsThisTurn}/${view.maxReviewsPerTurn} · 连续否决 ${view.consecutiveDenials}`
              : `${view.total} total · ${view.total - view.refused} allowed · ${view.refused} refused · this turn ${view.reviewsThisTurn}/${view.maxReviewsPerTurn} · streak ${view.consecutiveDenials}`}
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
