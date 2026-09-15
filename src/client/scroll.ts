/**
 * Scroll positioning for a view rendered inside someone else's scrollport.
 *
 * The Approvals tab is mounted inside the conversation's resident scrollport
 * (`.scrollBody`, `overflow-y: auto`), which the transcript keeps pinned to its
 * newest line. Switching tabs does not reset that box, so a ledger mounted under
 * it opens at its own BOTTOM — the opposite of useful when the newest decision
 * is the first row.
 *
 * A plugin cannot claim that scrollport: an intermediate slot element breaks the
 * height chain a `height: 100%; overflow: auto` root would need to become the
 * scroller itself. Resetting the nearest scrollable ancestor is the fix, and the
 * decision of WHICH ancestor that is lives here so it can be tested without a
 * browser.
 * @module dsh-approval-review/client/scroll
 */

/** The minimal element surface the walk needs. */
export interface ScrollableNode {
  /** Parent in the element tree, or null at the root. */
  readonly parentElement: ScrollableNode | null
  /** Full content height. */
  readonly scrollHeight: number
  /** Visible height. */
  readonly clientHeight: number
  /** Current scroll offset; assigned when this node is chosen. */
  scrollTop: number
}

/** Bound on the ancestor walk, so a pathological tree cannot spin. */
export const ANCESTOR_WALK_LIMIT = 12

/**
 * Reset the nearest scrollable ancestor that actually overflows.
 *
 * "Actually overflows" matters: an ancestor with `overflow-y: auto` but no
 * overflow cannot be scrolled, so resetting it is a no-op that would hide the
 * real scroller further up.
 * @param from - the element whose ancestry to search (usually the view root).
 * @param overflowYOf - computed `overflow-y` accessor for one node.
 * @param maxDepth - stop after this many ancestors.
 * @returns the node that was reset, or undefined when none qualified.
 */
export function resetScrollableAncestorToTop<T extends ScrollableNode>(
  from: T | null,
  overflowYOf: (node: T) => string,
  maxDepth: number = ANCESTOR_WALK_LIMIT,
): T | undefined {
  let node: ScrollableNode | null = from?.parentElement ?? null
  for (let depth = 0; node !== null && depth < maxDepth; depth += 1, node = node.parentElement) {
    const overflowY = overflowYOf(node as T)
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue
    if (node.scrollHeight <= node.clientHeight) continue
    node.scrollTop = 0
    return node as T
  }
  return undefined
}
