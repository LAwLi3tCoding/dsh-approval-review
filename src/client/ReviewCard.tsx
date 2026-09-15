/**
 * The review card: a session-header action that opens the full approval audit
 * ledger — every request, the reviewer's verdict and rationale, the risk grade,
 * the reviewer route, the timing, and the live budget/breaker state.
 *
 * The component is a pure projection of {@link ClientAuditView}; it performs no
 * IO of its own. Its only action is the one-shot override button, which is
 * optional: when the client supplies no command runner the card explains the
 * equivalent slash command instead of pretending to act.
 * @module dsh-approval-review/client/ReviewCard
 */

import { useMemo, useState, type CSSProperties } from 'react'
import type { ClientAuditRecord, ClientAuditView, ClientRisk } from './types.ts'

/** Props the card needs; `runCommand` is optional so the card degrades to text. */
export interface ReviewCardProps {
  /** The session's audit ledger, or undefined before the first frame lands. */
  readonly view: ClientAuditView | undefined
  /** Runs one slash command line in this session. */
  readonly runCommand?: (line: string) => void
  /** Whether to render copy in Chinese. */
  readonly zh: boolean
}

const TONES: Record<ClientRisk, string> = {
  low: 'var(--dsw-alias-state-success-primary, #2ea043)',
  medium: 'var(--dsw-alias-state-warn-primary, #d29922)',
  high: 'var(--dsw-alias-state-error-primary, #f85149)',
  critical: 'var(--dsw-alias-state-error-primary, #f85149)',
}

const REFUSED = 'var(--dsw-alias-state-error-primary, #f85149)'
const ALLOWED = 'var(--dsw-alias-state-success-primary, #2ea043)'
const MUTED = 'var(--dsw-alias-label-tertiary, #8b949e)'
const TEXT = 'var(--dsw-alias-label-primary, #e6edf3)'
const BORDER = 'var(--dsw-alias-border-l2, #30363d)'
const PANEL = 'var(--dsw-alias-bg-layer-2, #161b22)'
const CODE = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** Format an epoch millisecond value as a short wall-clock time. */
function clockOf(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** One labelled row of the record body. */
function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
      <span style={{ color: MUTED, flex: '0 0 auto', minWidth: 62, fontSize: 11 }}>{label}</span>
      <span style={{ color: TEXT, fontSize: 12, wordBreak: 'break-word', flex: '1 1 auto' }}>{children}</span>
    </div>
  )
}

/** Render one audit entry. */
function RecordCard({ record, zh, onApprove }: {
  record: ClientAuditRecord
  zh: boolean
  onApprove?: (record: ClientAuditRecord) => void
}): React.JSX.Element {
  const [openArguments, setOpenArguments] = useState(false)
  const verdict = record.refused
    ? (zh ? '否决' : 'refused')
    : record.outcome === 'allowed-once' ? (zh ? '放行' : 'allowed') : (zh ? '转人工' : 'delegated')
  const pending = record.outcome === undefined
  return (
    <div style={{
      border: `1px solid ${BORDER}`,
      borderRadius: 8,
      padding: '10px 12px',
      background: 'var(--dsw-alias-bg-layer-1, #0d1117)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: CODE, fontSize: 12, color: TEXT, fontWeight: 600 }}>{record.toolName}</span>
        <span style={{
          fontSize: 11,
          padding: '1px 6px',
          borderRadius: 999,
          color: pending ? MUTED : record.refused ? REFUSED : ALLOWED,
          border: `1px solid ${pending ? MUTED : record.refused ? REFUSED : ALLOWED}`,
        }}>{pending ? (zh ? '进行中' : 'pending') : verdict}</span>
        {record.risk === undefined ? null : (
          <span style={{ fontSize: 11, color: TONES[record.risk] }}>
            {zh ? '风险' : 'risk'} {record.risk}
          </span>
        )}
        {record.overridden ? (
          <span style={{ fontSize: 11, color: MUTED }}>{zh ? '含人工一次性授权' : 'human override attached'}</span>
        ) : null}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: MUTED }}>
          {clockOf(record.startedAt)} · T{record.turn}/S{record.step}
          {record.durationMs === undefined ? '' : ` · ${record.durationMs} ms`}
        </span>
      </div>

      <Row label={zh ? '理由' : 'rationale'}>
        <span style={{ color: record.reason === undefined ? MUTED : TEXT }}>
          {record.reason ?? (zh ? '（未记录：本次审批未经本插件裁决）' : '(not recorded: this approval was not decided by this plugin)')}
        </span>
      </Row>

      {record.suggestion === undefined ? null : (
        <Row label={zh ? '建议' : 'safer path'}>{record.suggestion}</Row>
      )}
      <Row label={zh ? '策略' : 'policy'}>
        <span style={{ fontFamily: CODE, fontSize: 11 }}>{record.policy} · {record.policySource}</span>
      </Row>
      {record.askReason === undefined ? null : (
        <Row label={zh ? '申请理由' : 'asked because'}>{record.askReason}</Row>
      )}
      {record.reviewerRoute === undefined ? null : (
        <Row label={zh ? '复核模型' : 'reviewer'}>
          <span style={{ fontFamily: CODE, fontSize: 11 }}>{record.reviewerRoute}</span>
          {record.uncertain ? <span style={{ color: MUTED }}> · {zh ? '不确定' : 'uncertain'}</span> : null}
        </Row>
      )}

      {record.argumentsPreview === undefined ? null : (
        <div>
          <button
            type="button"
            onClick={() => setOpenArguments(value => !value)}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              color: 'var(--dsw-alias-link, #58a6ff)', fontSize: 11,
            }}
          >{openArguments ? (zh ? '收起参数' : 'hide arguments') : (zh ? '查看参数' : 'show arguments')}</button>
          {openArguments ? (
            <pre style={{
              margin: '6px 0 0', padding: 8, borderRadius: 6, background: PANEL,
              fontFamily: CODE, fontSize: 11, color: TEXT, whiteSpace: 'pre-wrap',
              wordBreak: 'break-word', maxHeight: 200, overflow: 'auto',
            }}>{record.argumentsPreview}</pre>
          ) : null}
        </div>
      )}

      {!record.refused || onApprove === undefined || record.outcome !== 'rejected' ? null : (
        <button
          type="button"
          onClick={() => onApprove(record)}
          style={{
            alignSelf: 'flex-start', cursor: 'pointer', fontSize: 11, padding: '3px 8px',
            borderRadius: 6, border: `1px solid ${BORDER}`, background: 'transparent', color: TEXT,
          }}
        >{zh ? '授权重试一次' : 'approve one retry'}</button>
      )}
    </div>
  )
}

/**
 * One switch button in the card header. Disabled while already in that state, so
 * the control cannot issue a no-op command — a repeated no-op is what made the
 * reference panel's status look stuck.
 */
function SwitchButton({ label, active, disabled, onClick }: {
  label: string
  active: boolean
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      style={{
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${active ? ALLOWED : BORDER}`,
        color: disabled ? MUTED : TEXT,
        background: 'transparent',
      }}
    >{label}</button>
  )
}

/** The session-header button plus its popover ledger. */
export function ReviewCard({ view, runCommand, zh }: ReviewCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const records = view?.records ?? []
  const denials = useMemo(() => records.filter(record => record.refused).length, [records])
  const badge = view === undefined ? '' : String(records.length)

  const approve = (record: ClientAuditRecord): void => {
    if (runCommand === undefined) return
    const index = records.filter(candidate => candidate.refused).findIndex(candidate => candidate.reviewId === record.reviewId)
    runCommand(`/approval-review approve ${index + 1}`)
  }

  const panelStyle: CSSProperties = {
    position: 'absolute',
    top: 'calc(100% + 8px)',
    right: 0,
    zIndex: 40,
    width: 'min(760px, 90vw)',
    maxHeight: '70vh',
    overflow: 'auto',
    background: PANEL,
    border: `1px solid ${BORDER}`,
    borderRadius: 10,
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    boxShadow: 'var(--dsw-alias-bg-mask-drop, 0 8px 24px rgba(0,0,0,.45))',
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        title={zh ? '自动审批审计卡页' : 'Automatic approval audit'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
          fontSize: 12, padding: '4px 10px', borderRadius: 8,
          border: `1px solid ${BORDER}`, background: 'transparent', color: TEXT,
        }}
      >
        <span>{zh ? '审批审计' : 'Approvals'}</span>
        {view === undefined ? null : (
          <span style={{ fontSize: 11, color: denials > 0 ? REFUSED : MUTED }}>
            {denials > 0 ? `${denials}/${badge}` : badge}
          </span>
        )}
        {view?.circuitOpen === true ? <span style={{ fontSize: 11, color: REFUSED }}>⏻</span> : null}
      </button>

      {!open ? null : (
        <div style={panelStyle}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13, color: TEXT }}>{zh ? '自动审批审计' : 'Automatic approval audit'}</strong>
            <span style={{ fontSize: 11, color: view?.enabled === false ? MUTED : ALLOWED }}>
              {view === undefined
                ? (zh ? '尚无数据' : 'no data yet')
                : view.enabled ? (zh ? '已开启' : 'on') : (zh ? '已关闭' : 'off')}
            </span>
            {runCommand === undefined ? null : (
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <SwitchButton
                  label={zh ? '开启' : 'on'}
                  active={view?.enabled === true}
                  disabled={view?.enabled === true}
                  onClick={() => runCommand('/approval-review on')}
                />
                <SwitchButton
                  label={zh ? '关闭' : 'off'}
                  active={view?.enabled === false}
                  disabled={view?.enabled === false}
                  onClick={() => runCommand('/approval-review off')}
                />
              </span>
            )}
            {view === undefined ? null : (
              <span style={{ fontSize: 11, color: MUTED }}>
                {zh
                  ? `本回合复审 ${view.reviewsThisTurn}/${view.maxReviewsPerTurn} · 累计 ${view.total} · 否决 ${view.refused} · 连续 ${view.consecutiveDenials}`
                  : `this turn ${view.reviewsThisTurn}/${view.maxReviewsPerTurn} · total ${view.total} · refused ${view.refused} · streak ${view.consecutiveDenials}`}
              </span>
            )}
          </div>
          {view?.circuitOpen === true ? (
            <div style={{ fontSize: 11, color: REFUSED }}>
              {zh ? '否决熔断已触发：本回合后续请求转人工审批。' : 'Rejection circuit breaker is open: later requests in this turn go to the human chain.'}
            </div>
          ) : null}

          {records.length === 0 ? (
            <div style={{ fontSize: 12, color: MUTED }}>
              {zh
                ? '本会话还没有审批记录。需要审批的动作一旦发生，这里会留下完整的裁决理由。'
                : 'No approvals recorded in this session yet. Every future approval leaves its full rationale here.'}
            </div>
          ) : records.map(record => (
            <RecordCard key={record.reviewId} record={record} zh={zh} onApprove={runCommand === undefined ? undefined : approve} />
          ))}

          <div style={{ fontSize: 11, color: MUTED, borderTop: `1px solid ${BORDER}`, paddingTop: 6 }}>
            {zh
              ? '开关：/approval-review on|off　放行一条否决记录：/approval-review approve 1'
              : 'Switch: /approval-review on|off · approve one denial: /approval-review approve 1'}
          </div>
        </div>
      )}
    </div>
  )
}
