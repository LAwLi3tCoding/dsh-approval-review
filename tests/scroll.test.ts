/**
 * Scroll-reset tests.
 *
 * The rule under test is "which box gets reset": picking an ancestor that merely
 * declares `overflow-y: auto` without overflowing leaves the real scroller where
 * it was, which is exactly the bug this fixes.
 * @module dsh-approval-review/tests/scroll
 */

import { describe, expect, it } from 'vitest'
import { ANCESTOR_WALK_LIMIT, resetScrollableAncestorToTop, type ScrollableNode } from '../src/client/scroll.ts'

/** Build a chain of nodes, leaf first; each parent gets the child appended. */
function chain(specs: readonly { overflowY: string; scrollHeight: number; clientHeight: number; scrollTop: number }[]): {
  leaf: ScrollableNode
  nodes: ScrollableNode[]
} {
  const nodes: ScrollableNode[] = specs.map(spec => ({
    parentElement: null,
    scrollHeight: spec.scrollHeight,
    clientHeight: spec.clientHeight,
    scrollTop: spec.scrollTop,
  }))
  for (let index = 1; index < nodes.length; index += 1) {
    ;(nodes[index - 1] as { parentElement: ScrollableNode | null }).parentElement = nodes[index]!
  }
  const leaf: ScrollableNode = { parentElement: nodes[0]!, scrollHeight: 10, clientHeight: 10, scrollTop: 0 }
  return { leaf, nodes }
}

/** Computed-style stub keyed by node identity. */
function overflowOf(table: Map<ScrollableNode, string>) {
  return (node: ScrollableNode): string => table.get(node) ?? 'visible'
}

describe('resetScrollableAncestorToTop', () => {
  it('resets the nearest overflowing scroll container', () => {
    // leaf → wrapper (not a scroller) → scrollBody (the conversation scrollport)
    const { leaf, nodes } = chain([
      { overflowY: 'visible', scrollHeight: 100, clientHeight: 100, scrollTop: 0 },
      { overflowY: 'auto', scrollHeight: 900, clientHeight: 300, scrollTop: 600 },
    ])
    const styles = new Map<ScrollableNode, string>([[nodes[0]!, 'visible'], [nodes[1]!, 'auto']])
    expect(resetScrollableAncestorToTop(leaf, overflowOf(styles))).toBe(nodes[1])
    expect(nodes[1]!.scrollTop).toBe(0)
  })

  it('skips an ancestor that declares auto but does not overflow', () => {
    const { leaf, nodes } = chain([
      { overflowY: 'auto', scrollHeight: 300, clientHeight: 300, scrollTop: 120 },
      { overflowY: 'auto', scrollHeight: 900, clientHeight: 300, scrollTop: 600 },
    ])
    const styles = new Map<ScrollableNode, string>([[nodes[0]!, 'auto'], [nodes[1]!, 'auto']])
    expect(resetScrollableAncestorToTop(leaf, overflowOf(styles))).toBe(nodes[1])
    expect(nodes[0]!.scrollTop).toBe(120)
    expect(nodes[1]!.scrollTop).toBe(0)
  })

  it('treats scroll as a scroller too, and ignores hidden', () => {
    const { leaf, nodes } = chain([
      { overflowY: 'hidden', scrollHeight: 900, clientHeight: 300, scrollTop: 50 },
      { overflowY: 'scroll', scrollHeight: 900, clientHeight: 300, scrollTop: 500 },
    ])
    const styles = new Map<ScrollableNode, string>([[nodes[0]!, 'hidden'], [nodes[1]!, 'scroll']])
    expect(resetScrollableAncestorToTop(leaf, overflowOf(styles))).toBe(nodes[1])
    expect(nodes[0]!.scrollTop).toBe(50)
    expect(nodes[1]!.scrollTop).toBe(0)
  })

  it('reports nothing when no ancestor qualifies, and survives a detached root', () => {
    const { leaf, nodes } = chain([{ overflowY: 'visible', scrollHeight: 9, clientHeight: 1, scrollTop: 3 }])
    expect(resetScrollableAncestorToTop(leaf, overflowOf(new Map()))).toBeUndefined()
    expect(nodes[0]!.scrollTop).toBe(3)
    expect(resetScrollableAncestorToTop(null, overflowOf(new Map()))).toBeUndefined()
  })

  it('stops after the walk limit', () => {
    const specs = Array.from({ length: ANCESTOR_WALK_LIMIT + 2 }, () => ({
      overflowY: 'visible', scrollHeight: 10, clientHeight: 1, scrollTop: 0,
    }))
    specs[specs.length - 1] = { overflowY: 'auto', scrollHeight: 900, clientHeight: 300, scrollTop: 400 }
    const { leaf, nodes } = chain(specs)
    const styles = new Map<ScrollableNode, string>()
    for (const node of nodes) styles.set(node, 'visible')
    styles.set(nodes[nodes.length - 1]!, 'auto')
    expect(resetScrollableAncestorToTop(leaf, overflowOf(styles))).toBeUndefined()
    expect(nodes[nodes.length - 1]!.scrollTop).toBe(400)
  })
})
