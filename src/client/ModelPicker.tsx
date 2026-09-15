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

/** Props for the picker. */
export interface ModelPickerProps {
  /** Routes this deployment offers, in display order. */
  readonly choices: readonly string[]
  /** Apply one shell command line (the picker emits `/approval-review model …`). */
  readonly runCommand: (line: string) => void
  /** Load the catalog on first use. */
  readonly loadModels?: (() => Promise<readonly string[]>) | undefined
  /** Whether to render copy in Chinese. */
  readonly zh: boolean
  /** Replaces the base list once the catalog arrives; base first. */
  readonly onChoicesLoaded: (routes: readonly string[]) => void
}

const TEXT = 'var(--dsw-alias-label-primary, #e6edf3)'
const MUTED = 'var(--dsw-alias-label-tertiary, #8b949e)'
const BORDER = 'var(--dsw-alias-border-l2, #30363d)'
const PANEL = 'var(--dsw-alias-bg-layer-2, #161b22)'
const HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))'
const CODE = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** The picker's field and its plugin-rendered list. */
export function ModelPicker({ choices, runCommand, loadModels, zh, onChoicesLoaded }: ModelPickerProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLSpanElement>(null)
  const requestedRef = useRef(false)

  const matches = useMemo(() => filterRoutes(choices, draft), [choices, draft])

  /** Fetch the catalog once, on first interaction. */
  const loadOnce = (): void => {
    if (requestedRef.current || loadModels === undefined) return
    requestedRef.current = true
    void loadModels()
      .then(routes => onChoicesLoaded(routes))
      .catch(() => onChoicesLoaded([]))
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
        aria-label={zh ? '复核模型' : 'reviewer model'}
        placeholder={zh ? '选择或输入模型' : 'pick or type a model'}
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
              {choices.length === 0
                ? (zh ? '没有可选模型，直接输入 id 后回车' : 'no models to pick from — type an id and press Enter')
                : (zh ? '没有匹配的模型' : 'no matching model')}
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
            >{route}</button>
          ))}
        </span>
      ) : null}
    </span>
  )
}
