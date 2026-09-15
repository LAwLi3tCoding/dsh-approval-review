/**
 * The composer "who decides" toggle.
 *
 * This is the SECOND AXIS, deliberately not a fourth access-mode preset. Codex
 * keeps `sandbox_mode` (how much can be touched) separate from
 * `approvals_reviewer` (who answers when a boundary is crossed); DSH's access
 * menu owns only `sandbox` + `approval`, so folding a reviewer choice into it
 * would claim a distinction the preset table cannot record. Sitting next to the
 * access-mode chip keeps the pair readable while staying honest about what each
 * one means.
 *
 * Rendered as a compact chip: a label and two mutually exclusive states. Clicking
 * the inactive state emits the slash command, so the host remains the only writer
 * of the switch and the projection is the only reader.
 * @module dsh-approval-review/client/ReviewToggle
 */

import type { CSSProperties } from 'react'
import type { ClientAuditView } from './types.ts'

/** Props the toggle needs; `runCommand` is optional so it degrades to a label. */
export interface ReviewToggleProps {
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
const AI_ON = 'var(--dsw-alias-state-success-primary, #2ea043)'
const REFUSED = 'var(--dsw-alias-state-error-primary, #f85149)'

/** One clickable state segment. */
function Segment({ label, active, tone, onClick, title }: {
  label: string
  active: boolean
  tone: string
  onClick?: (() => void) | undefined
  title: string
}): React.JSX.Element {
  const style: CSSProperties = {
    padding: '2px 7px',
    borderRadius: 6,
    fontSize: 11,
    cursor: onClick === undefined ? 'default' : 'pointer',
    border: `1px solid ${active ? tone : 'transparent'}`,
    color: active ? tone : MUTED,
    background: active ? 'transparent' : 'transparent',
    fontWeight: active ? 600 : 400,
  }
  return onClick === undefined
    ? <span style={style} title={title}>{label}</span>
    : <button type="button" style={style} title={title} onClick={onClick}>{label}</button>
}

/** The compact who-decides chip. */
export function ReviewToggle({ view, zh, runCommand }: ReviewToggleProps): React.JSX.Element {
  const enabled = view?.enabled ?? true
  const send = (line: string) => () => runCommand?.(line)
  const canSwitch = runCommand !== undefined
  const label = zh ? '自动审批' : 'Auto-approval'
  const aiTitle = zh
    ? '由独立复核模型裁决需要审批的动作（写入本次会话）'
    : 'Let an independent reviewer model decide actions that need approval (this session)'
  const humanTitle = zh
    ? '需要审批的动作交回人工应答（写入本次会话）'
    : 'Send actions that need approval back to the human answerer (this session)'

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        padding: '2px 6px',
        fontSize: 11,
        color: TEXT,
      }}
      title={label}
    >
      <span style={{ color: MUTED }}>{label}</span>
      <Segment
        label={zh ? '人工' : 'human'}
        active={!enabled}
        tone={REFUSED}
        onClick={canSwitch && enabled ? send('/approval-review off') : undefined}
        title={humanTitle}
      />
      <Segment
        label={zh ? 'AI' : 'AI'}
        active={enabled}
        tone={AI_ON}
        onClick={canSwitch && !enabled ? send('/approval-review on') : undefined}
        title={aiTitle}
      />
      {view?.circuitOpen === true ? (
        <span style={{ color: REFUSED }} title={zh ? '本回合否决熔断已打开' : 'rejection breaker open this turn'}>⏻</span>
      ) : null}
      {view === undefined ? <span style={{ color: MUTED }}>…</span> : null}
    </div>
  )
}
