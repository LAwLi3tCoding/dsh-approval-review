/**
 * Access-mode glyph tests.
 *
 * The shim decorates a control the harness owns, so the rule that decides WHICH
 * button gets the mark is the part worth pinning: a wrong match would put this
 * plugin's eye on a sandbox mode it does not describe, and a match that ignores
 * the built-in glyph would double the icon after a harness rebuild.
 * @module dsh-approval-review/tests/access-mode-glyph
 */

import { describe, expect, it } from 'vitest'
import { accessModeGlyphDecision } from '../src/client/access-mode-glyph.ts'

describe('accessModeGlyphDecision', () => {
  it('marks the trigger whose aria-label names the preset', () => {
    expect(accessModeGlyphDecision({ ariaLabel: '访问模式，当前：替我审批' })).toBe('mark')
    expect(accessModeGlyphDecision({ ariaLabel: 'Access mode, current: Approve for me' })).toBe('mark')
  })

  it('marks a menu row whose own text is the preset name', () => {
    expect(accessModeGlyphDecision({ role: 'menuitem', text: '替我审批' })).toBe('mark')
    expect(accessModeGlyphDecision({ role: 'menuitem', text: '  替我审批  ' })).toBe('mark')
  })

  it('leaves a different access mode alone', () => {
    expect(accessModeGlyphDecision({ ariaLabel: '访问模式，当前：工作区内修改' })).toBe('skip')
    expect(accessModeGlyphDecision({ role: 'menuitem', text: '完全权限' })).toBe('skip')
  })

  it('does not match the preset name outside a menu row', () => {
    // A message body that merely quotes the label must not be decorated.
    expect(accessModeGlyphDecision({ text: '替我审批' })).toBe('skip')
    expect(accessModeGlyphDecision({ role: 'button', text: '替我审批' })).toBe('skip')
  })

  it('yields to the glyph the harness already draws', () => {
    // After a harness rebuild that ships the glyph, the shim must step aside.
    expect(accessModeGlyphDecision({ ariaLabel: '访问模式，当前：替我审批', hasBuiltInGlyph: true })).toBe('skip')
    expect(accessModeGlyphDecision({ role: 'menuitem', text: '替我审批', hasBuiltInGlyph: true })).toBe('skip')
  })

  it('skips an element with no facts at all', () => {
    expect(accessModeGlyphDecision({})).toBe('skip')
    expect(accessModeGlyphDecision({ ariaLabel: null, role: null, text: '' })).toBe('skip')
  })
})

describe('the mark follows the design system colours', () => {
  it('is exported stylesheet text and tints menu rows like the built-in icon slot', async () => {
    // The built-in glyphs live in `.itemIcon`, tinted `--dsw-alias-label-tertiary`,
    // while the button itself is `label-primary`. A `::before` on the button
    // therefore needs the explicit token or it reads as a brighter icon.
    const module = await import('../src/client/access-mode-glyph.ts')
    const css = (module as unknown as { __stylesheetForTest?: () => string }).__stylesheetForTest?.()
    expect(css).toBeDefined()
    expect(css).toContain('button[role="menuitem"][data-dsh-approval-review-glyph]::before')
    expect(css).toContain('--dsw-alias-label-tertiary')
  })
})
