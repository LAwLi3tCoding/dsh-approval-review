/**
 * The "approve for me" access-mode glyph, installed from this plugin.
 *
 * Background: the composer's access-mode menu draws a shield glyph for each
 * permission preset, and that glyph table is a CLOSED design set inside
 * `@deepseek-ai/dsh-client-ui-conversation` — a preset key outside it renders
 * with no icon at all, and the host cannot be asked for one (the `permissions`
 * projection carries value/name/description only). So a plugin that adds a
 * fourth preset gets a fourth menu row with no picture next to it.
 *
 * Two ways out exist. Editing the harness package is the tidy one, but it only
 * takes effect after that package is rebuilt, and it couples the harness to a
 * plugin-specific key. This module is the other one: the plugin decorates the
 * two buttons the menu renders, from the outside, with the same shield+eye mark.
 *
 * Why it decorates by ATTRIBUTE and not by inserting nodes: these buttons belong
 * to React. Inserting a child would put an unknown node where React expects its
 * own child list and would make a later re-render reconcile against DOM it never
 * produced. Setting a `data-*` attribute and drawing the glyph from a
 * plugin-owned stylesheet via `::before` leaves React's tree untouched — React
 * does not remove attributes it never set, and a remount simply loses the mark
 * until the next pass, which the observer re-applies.
 *
 * The shim YIELDS to the built-in glyph: when the harness glyph table already
 * covers this key (i.e. the package was rebuilt with it), the mark is removed
 * and the stylesheet draws nothing, so a rebuild never produces a double icon.
 *
 * Naming coupling: the preset key comes from `Config.reviewerPreset` and the
 * bundle patch's `permission.presets` entry, and the display name from that same
 * entry's `name`. The DOM exposes the NAME (the trigger's `aria-label`, a menu
 * row's text), never the key, so the label list below is what this shim matches.
 * Rename the preset and the glyph simply does not appear; the menu keeps
 * working, which is why this is a progressive enhancement and not a dependency.
 * @module dsh-approval-review/client/access-mode-glyph
 */

/**
 * Display names the preset may carry, matched against the access-mode trigger's
 * `aria-label` ("访问模式，当前：替我审批" / "Access mode, current: Approve for
 * me") and against a menu row's own text. The bundle patch ships the Chinese
 * name; the English form is accepted so an English deployment still gets its
 * glyph.
 */
const PRESET_LABELS: readonly string[] = ['替我审批', 'Approve for me']

/** Marks a decorated button; also the selector the stylesheet hangs off. */
const MARK_ATTRIBUTE = 'data-dsh-approval-review-glyph'

/** The style element's identity, so a re-install replaces its own node. */
const STYLE_ATTRIBUTE = 'data-dsh-approval-review-glyph-style'

/** The shield outline shared by every built-in access-mode glyph. */
const SHIELD_OUTLINE =
  'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z'

/**
 * The glyph itself: the same shield as the built-in modes — the boundary is
 * unchanged — carrying an eye, because the reviewer looks at the action before
 * it crosses. Rendered as a MASK, so the mark takes `currentColor` from the
 * button exactly like the built-in `currentColor` SVGs do.
 */
const GLYPH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">'
  + `<path d="${SHIELD_OUTLINE}" stroke="#000" stroke-width="1.31831" stroke-linejoin="round"/>`
  + '<path d="M5.348 6.58C6.224 7.773 7.029 8.375 8.2 8.375C9.371 8.375 10.176 7.773 11.052 6.58" stroke="#000" stroke-width="1.31831" stroke-linecap="round"/>'
  + '<path d="M5.348 6.58C6.224 5.387 7.029 4.785 8.2 4.785C9.371 4.785 10.176 5.387 11.052 6.58" stroke="#000" stroke-width="1.31831" stroke-linecap="round"/>'
  + '<circle cx="8.2" cy="6.58" r="0.95" fill="#000"/>'
  + '</svg>'

/**
 * The one selector every pass and every mutation check uses.
 *
 * It is deliberately narrow: the trigger is addressed by SUBSTRING on the
 * `aria-label` (a native attribute test, not a JavaScript scan of every button
 * in the document), menu rows by role, and already-marked buttons — whichever
 * they are — by the mark itself, so a mode switch clears the old one.
 */
const TARGET_SELECTOR = [
  ...PRESET_LABELS.map(label => `button[aria-label*="${label}"]`),
  'button[role="menuitem"]',
  `[${MARK_ATTRIBUTE}]`,
].join(', ')

/**
 * Build the stylesheet that draws the mark on a decorated button.
 *
 * The colour is not cosmetic guesswork: the built-in glyphs sit inside the
 * menu's `.itemIcon` span, which the design system tints
 * `--dsw-alias-label-tertiary`, while the button itself is
 * `--dsw-alias-label-primary` (brighter, and brighter still on the selected
 * row). A `::before` on the button therefore inherits the WRONG one, which is
 * why the mark looked white next to three grey shields. The trigger has no such
 * span — its built-in icon inherits the button — so it keeps `currentColor`.
 */
function stylesheet(): string {
  const mask = `url("data:image/svg+xml,${encodeURIComponent(GLYPH_SVG)}")`
  return `
[${MARK_ATTRIBUTE}]::before{
  content:"";
  display:inline-block;
  flex:none;
  width:16px;
  height:16px;
  background-color:currentColor;
  -webkit-mask-image:${mask};
  mask-image:${mask};
  -webkit-mask-repeat:no-repeat;
  mask-repeat:no-repeat;
  -webkit-mask-position:center;
  mask-position:center;
  -webkit-mask-size:contain;
  mask-size:contain;
}
/* A menu row's icon slot is tinted tertiary; match it instead of the button. */
button[role="menuitem"][${MARK_ATTRIBUTE}]::before{
  background-color:var(--dsw-alias-label-tertiary, currentColor);
}
/* The composer trigger sizes its icons at 14px and lets them inherit. */
button[aria-label][${MARK_ATTRIBUTE}]::before{
  width:14px;
  height:14px;
}
`
}

/** Exported for tests: the exact stylesheet the shim installs. */
export function __stylesheetForTest(): string {
  return stylesheet()
}

/**
 * Whether an element already carries the harness's own glyph.
 *
 * Both surfaces render the built-in icon as a leading `<span>` holding an
 * `<svg>`; the trailing chevron is a later sibling, so only the first child
 * counts. When this is true the shim steps aside.
 */
function hasBuiltInGlyph(button: HTMLElement): boolean {
  const first = button.firstElementChild
  return first instanceof HTMLElement
    && first.tagName === 'SPAN'
    && first.querySelector('svg') !== null
}

/**
 * The pure matching rule behind the shim.
 *
 * Extracted from the DOM pass so the rule that can actually go wrong — which
 * button is this plugin's preset, and does it already have a built-in glyph —
 * is testable without a browser. The DOM *plumbing* around it is decoration and
 * degrades to "no glyph", never to a broken menu.
 * @param facts - the element facts the shim matches on.
 * @returns `'mark'` when this plugin should draw the glyph, `'skip'` otherwise.
 */
export function accessModeGlyphDecision(facts: {
  readonly ariaLabel?: string | null
  readonly role?: string | null
  readonly text?: string
  readonly hasBuiltInGlyph?: boolean
}): 'mark' | 'skip' {
  const label = facts.ariaLabel ?? ''
  const isTarget = PRESET_LABELS.some(candidate => label.includes(candidate))
    || (facts.role === 'menuitem' && PRESET_LABELS.includes((facts.text ?? '').trim()))
  if (!isTarget) return 'skip'
  return facts.hasBuiltInGlyph === true ? 'skip' : 'mark'
}

/**
 * Install the access-mode glyph decoration.
 *
 * The observer is deliberately cheap: it inspects only MUTATED subtrees for the
 * target selector and coalesces every hit into one animation frame, so a
 * streaming conversation (which appends text nodes constantly) never becomes a
 * per-token query over the document.
 * @param root - document to decorate; injectable for tests.
 * @returns the disposer that removes the stylesheet, the marks, and the observer.
 */
export function installAccessModeGlyph(root: Document = document): () => void {
  if (root.querySelector(`style[${STYLE_ATTRIBUTE}]`) === null) {
    const style = root.createElement('style')
    style.setAttribute(STYLE_ATTRIBUTE, '1')
    style.textContent = stylesheet()
    root.head.appendChild(style)
  }

  const decorate = (): void => {
    for (const button of root.querySelectorAll<HTMLElement>(TARGET_SELECTOR)) {
      const decision = accessModeGlyphDecision({
        ariaLabel: button.getAttribute('aria-label'),
        role: button.getAttribute('role'),
        text: button.textContent ?? '',
        hasBuiltInGlyph: hasBuiltInGlyph(button),
      })
      if (decision === 'mark') {
        if (!button.hasAttribute(MARK_ATTRIBUTE)) button.setAttribute(MARK_ATTRIBUTE, '1')
      } else if (button.hasAttribute(MARK_ATTRIBUTE)) {
        // Either the harness grew its own glyph, or the access mode moved on.
        // Both mean this plugin's mark no longer belongs on this button.
        button.removeAttribute(MARK_ATTRIBUTE)
      }
    }
  }

  /** True when a mutation could have produced one of the decorated buttons. */
  const mightMatter = (node: Node): boolean => {
    if (!(node instanceof Element)) return false
    if (node.matches(TARGET_SELECTOR)) return true
    return node.querySelector(TARGET_SELECTOR) !== null
  }

  let frame: number | undefined
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = root.defaultView?.requestAnimationFrame(() => {
      frame = undefined
      decorate()
    })
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      // A change INSIDE a target button matters too: React growing the built-in
      // icon inserts a span, not a button, and this shim has to notice that and
      // step aside — otherwise a harness rebuild paints two glyphs.
      const target = record.target
      if (target instanceof Element && target.closest(TARGET_SELECTOR) !== null) {
        schedule()
        return
      }
      for (const node of record.addedNodes) {
        if (mightMatter(node)) {
          schedule()
          return
        }
      }
    }
  })
  // A client bundle can execute before `body` exists; the initial pass still
  // runs, and the observer simply arrives with the next install.
  if (root.body !== null) observer.observe(root.body, { childList: true, subtree: true })

  // The initial pass covers a composer that rendered before this plugin mounted.
  decorate()

  return () => {
    observer.disconnect()
    if (frame !== undefined) root.defaultView?.cancelAnimationFrame(frame)
    for (const button of root.querySelectorAll<HTMLElement>(`[${MARK_ATTRIBUTE}]`)) {
      button.removeAttribute(MARK_ATTRIBUTE)
    }
    root.querySelector(`style[${STYLE_ATTRIBUTE}]`)?.remove()
  }
}
