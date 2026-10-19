import { useCallback, useEffect, useRef } from 'react'

const BOTTOM_MARGIN_PX = 48

export interface TimelineScroll {
  readonly ref: React.RefObject<HTMLElement>
  onScroll: () => void
  /** Whether the reader currently sits within the follow margin of the bottom. */
  isPinned: () => boolean
  /** Scroll the timeline to the latest fact immediately. */
  scrollToBottom: () => void
  /**
   * Re-establish the position the reader left with after the scrolling box was
   * unmounted and mounted again (the Thread view switching away and back). A
   * fresh box starts at `scrollTop` 0 — the earliest fact — so a reader who was
   * following the tail is put back on it, and a reader who had scrolled up to
   * history keeps that position untouched.
   */
  returnToTimeline: () => void
  /**
   * Bring one descendant row to the middle of the timeline. `smooth` asks for an
   * animated move; the opening jump wants an instant one.
   */
  centerOn: (node: HTMLElement, options?: { readonly smooth?: boolean }) => void
}

/**
 * Centre one row inside a scroll container by moving that container's own
 * `scrollTop`, never by asking an ancestor to scroll.
 *
 * `Element.scrollIntoView` walks up the ancestor chain and scrolls every
 * scrollable box it meets, so centring a Message inside `.timeline` also
 * disturbs whatever scrolls the page around it — the sidebar, the panel host,
 * the window. Setting `scrollTop` on the container states the intent exactly:
 * this box, this row, this many pixels. The container is the only thing that
 * moves.
 *
 * The caller keeps ownership of the clamp: `scrollTop` is silently clamped to
 * the container's range by the DOM, so a row near either end lands as close to
 * the middle as the content allows rather than overscrolling the box.
 */
function centerInContainer(container: HTMLElement, node: HTMLElement): void {
  container.scrollTop = node.offsetTop - container.clientHeight / 2 + node.clientHeight / 2
}

/**
 * The nearest ancestor that actually scrolls `node`, or null when nothing above
 * it does. Used where the caller holds the row but not the box: a to-do card
 * sits in `css.todoList` inside the scrolling `css.board`, so the container is
 * discovered rather than assumed, and the jump still moves exactly one box.
 *
 * An element counts as the container when its computed `overflow-y` is one of
 * the scrolling values AND it has somewhere to scroll. The overflow test alone
 * would stop at a box that is merely clipped, and stopping there would leave the
 * row off-screen; the range test alone would pick a non-scrolling ancestor.
 */
export function scrollContainerOf(node: HTMLElement): HTMLElement | null {
  const scrolling = ['auto', 'scroll', 'overlay']
  for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
    if (!scrolling.includes(getComputedStyle(parent).overflowY)) continue
    if (parent.scrollHeight <= parent.clientHeight) continue
    return parent
  }
  return null
}

/**
 * Centre one row inside whichever ancestor scrolls it, moving that container's
 * own `scrollTop` and nothing else. Unlike the timeline call site the container
 * is not known in advance, so it is resolved here; when nothing scrolls the row
 * there is nothing to centre and the call is a no-op rather than a jump to the
 * page top.
 */
export function centerInOwnScroller(node: HTMLElement): void {
  const container = scrollContainerOf(node)
  if (container === null) return
  centerInContainer(container, node)
}

/**
 * Chat-timeline scroll policy shared by the Channel and Thread pages: follow
 * new facts only while the reader stays pinned to the bottom, and keep
 * prepended history visually stable. The content key must change whenever
 * rendered facts change.
 */
export function useTimelineScroll(contentKey: string): TimelineScroll {
  const ref = useRef<HTMLElement>(null)
  const pinnedRef = useRef(true)
  const heightRef = useRef(0)

  const onScroll = useCallback(() => {
    const element = ref.current
    if (element === null) return
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_MARGIN_PX
  }, [])

  const scrollToBottom = useCallback(() => {
    const element = ref.current
    pinnedRef.current = true
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [])

  // The animated branch still animates the container itself: `scrollTo` is the
  // container's own method, so an ancestor is never asked to move. Browsers
  // without it (jsdom, older engines) silently keep the instant path.
  const centerOn = useCallback((node: HTMLElement, options?: { readonly smooth?: boolean }) => {
    const element = ref.current
    if (element === null) return
    if (options?.smooth === true && typeof element.scrollTo === 'function') {
      const top = node.offsetTop - element.clientHeight / 2 + node.clientHeight / 2
      element.scrollTo({ top, behavior: 'smooth' })
      return
    }
    centerInContainer(element, node)
  }, [])

  // Follow state outlives the box: the panel holding it unmounts on a view
  // switch while this hook stays mounted, so the policy — not the element —
  // remembers where the reader was.
  const returnToTimeline = useCallback(() => {
    const element = ref.current
    if (element === null) return
    // A fresh box has no height history to compare against; take the mounted
    // height as the baseline so the follow below behaves as on any other commit.
    heightRef.current = element.scrollHeight
    if (pinnedRef.current) element.scrollTop = element.scrollHeight
  }, [])

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const previousHeight = heightRef.current
    heightRef.current = element.scrollHeight
    if (pinnedRef.current) {
      element.scrollTop = element.scrollHeight
      return
    }
    // Prepended older history must not shift the content the reader is on.
    if (previousHeight > 0 && element.scrollHeight > previousHeight) {
      element.scrollTop += element.scrollHeight - previousHeight
    }
  }, [contentKey])

  return { ref, onScroll, isPinned: () => pinnedRef.current, scrollToBottom, centerOn, returnToTimeline }
}
