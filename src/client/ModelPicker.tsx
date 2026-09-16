/**
 * The reviewer-model picker.
 *
 * A native `<datalist>` (or `<select>`) popup is drawn by the browser, not the
 * page: its font, weight, and width ignore CSS entirely, which made the list
 * read as a different, much louder control than the tab it sits in. This is the
 * plugin's own listbox instead, styled with the ledger's own type scale, with a
 * free-text field on top so an id the catalog no longer advertises stays
 * reachable (catalog membership is advisory).
 * @module dsh-approval-review/client/ModelPicker
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { filterRoutes } from './model-choices.ts'
import type { ApprovalReviewTranslate } from './locale.ts'

/** Props for the picker. */
export interface ModelPickerProps {
  /** Routes this deployment offers, in display order. */
  readonly choices: readonly string[]
  /**
   * Route id → the catalog's display name ("DeepSeek-V41-Flash" for
   * `deepseek-official/deepseek-flash`). The id is what the command needs, but it
   * is not the vendor's model name, and that mismatch reads as a bug.
   */
  readonly labels?: Readonly<Record<string, string>> | undefined
  /** Apply one shell command line (the picker emits `/approval-review model …`). */
  readonly runCommand: (line: string) => void
  /** Load the catalog on first use. */
  readonly loadModelRoutes?: (() => Promise<{
    readonly routes: readonly string[]
    readonly labels: Readonly<Record<string, string>>
  }>) | undefined
  /**
   * Translate function for this plugin's copy, bound to the ACTIVE harness
   * locale (the ledger's own `t` seat; a language switch hands out a new
   * reference, so this list re-renders with the tab).
   */
  readonly t: ApprovalReviewTranslate
  /** Replaces the base list once the catalog arrives; base first. */
  readonly onRoutesLoaded: (loaded: {
    readonly routes: readonly string[]
    readonly labels: Readonly<Record<string, string>>
  }) => void
}

const TEXT = 'var(--dsw-alias-label-primary, #e6edf3)'
const MUTED = 'var(--dsw-alias-label-tertiary, #8b949e)'
const BORDER = 'var(--dsw-alias-border-l2, #30363d)'
const PANEL = 'var(--dsw-alias-bg-layer-2, #161b22)'
const HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))'
const CODE = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** The picker's field and its plugin-rendered list. */
export function ModelPicker({ choices, labels, runCommand, loadModelRoutes, t, onRoutesLoaded }: ModelPickerProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLSpanElement>(null)
  const requestedRef = useRef(false)

  const matches = useMemo(() => filterRoutes(choices, draft), [choices, draft])

  /** Fetch the catalog once, on first interaction. */
  const loadOnce = (): void => {
    if (requestedRef.current || loadModelRoutes === undefined) return
    requestedRef.current = true
    void loadModelRoutes()
      .then(loaded => onRoutesLoaded(loaded))
      .catch(() => onRoutesLoaded({ routes: [], labels: {} }))
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
  }, [open])

  const apply = (route: string): void => {
    const value = route.trim()
    if (value.length === 0) return
    runCommand(`/approval-review model ${value}`)
    setDraft('')
    setOpen(false)
  }

  const fieldStyle: CSSProperties = {
    fontFamily: CODE,
    fontSize: 11,
    lineHeight: '16px',
    padding: '2px 6px',
    width: 190,
    borderRadius: 6,
    border: `1px solid ${BORDER}`,
    background: 'transparent',
    color: TEXT,
    outline: 'none',
  }

  /** One row's text: the id that will be sent, plus the name a human recognizes. */
  const textOf = (route: string): string => {
    const name = labels?.[route]
    return name === undefined ? route : `${route} · ${name}`
  }

  const itemStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    // The ledger's own type scale: this list is chrome, not a headline.
    fontFamily: CODE,
    fontSize: 11,
    fontWeight: 400,
    lineHeight: '16px',
    padding: '3px 8px',
    color: TEXT,
  }

  return (
    <span ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <input
        value={draft}
        role="combobox"
        aria-expanded={open}
        aria-label={t('pickModel')}
        placeholder={t('pickPlaceholder')}
        style={fieldStyle}
        onFocus={() => { loadOnce(); setOpen(true) }}
        onClick={() => { loadOnce(); setOpen(true) }}
        onChange={(event) => { setDraft(event.target.value); setHighlight(0); setOpen(true) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { setOpen(false); return }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (matches.length === 0) return
            setOpen(true)
            setHighlight(current => {
              const next = event.key === 'ArrowDown' ? current + 1 : current - 1
              return (next + matches.length) % matches.length
            })
            return
          }
          if (event.key !== 'Enter') return
          // Enter takes the highlighted suggestion when the list is open, and
          // otherwise applies exactly what was typed.
          const picked = open ? matches[highlight] : undefined
          apply(picked ?? draft)
        }}
      />
      {open ? (
        <span
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 60,
            minWidth: '100%',
            maxWidth: 320,
            maxHeight: 220,
            overflowY: 'auto',
            background: PANEL,
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            padding: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,.45)',
          }}
        >
          {matches.length === 0 ? (
            <span style={{ ...itemStyle, color: MUTED, cursor: 'default' }}>
              {choices.length === 0 ? t('noModels') : t('noMatch')}
            </span>
          ) : matches.map((route, index) => (
            <button
              key={route}
              type="button"
              role="option"
              aria-selected={index === highlight}
              style={{ ...itemStyle, background: index === highlight ? HOVER : 'transparent' }}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => apply(route)}
            >{textOf(route)}</button>
          ))}
        </span>
      ) : null}
    </span>
  )
}
