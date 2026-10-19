import { useCallback, useEffect, useRef } from 'react'

const BOTTOM_MARGIN_PX = 48

/**
 * Whether the box sits within the follow margin of its bottom. The bottom margin
 * is how a reader at the tail absorbs growth that lands under them; anything
 * further away is a position they chose. It must stay an explicit offset, never
 * a fraction of the viewport: a shorter box would otherwise treat ordinary
 * growth as "the reader scrolled up" and pin a following conversation in place.
 */
function withinFollowMargin(element: HTMLElement | null): boolean {
  return element !== null && element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_MARGIN_PX
}

/**
 * How far down its own scrollable range one box sits, from 0 at the earliest
 * fact to 1 at the latest. Ratios rather than pixels because the box that comes
 * back is not the box the reader left: the panel is remounted, so its height and
 * its content may both differ, and a pixel offset would land somewhere else.
 */
function scrollFraction(element: HTMLElement): number {
  const range = element.scrollHeight - element.clientHeight
  return range <= 0 ? 0 : element.scrollTop / range
}

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
  // Where the reader's view started, as a fraction of the box's scrollable
  // range. `scrollTop` itself is meaningless once the box is gone: the panel
  // unmounts on a view switch and a fresh box would reopen at 0, the oldest
  // fact. The fraction survives that round trip and is restored below.
  const offsetRef = useRef(0)
  // A box the reader has not scrolled yet opens everywhere at `scrollTop` 0,
  // which says nothing about where they want to be — it is the browser's
  // default, not a choice. Only a real scroll (or an explicit jump) records a
  // position; until then the policy's own follow state speaks for them.
  const scrolledRef = useRef(false)

  const onScroll = useCallback(() => {
    const element = ref.current
    if (element === null) return
    pinnedRef.current = withinFollowMargin(element)
    // Growth landing under a reader at the tail scrolls them without their
    // input; that is still the browser speaking, not them.
    if (!pinnedRef.current) scrolledRef.current = true
    offsetRef.current = scrollFraction(element)
  }, [])

  const scrollToBottom = useCallback(() => {
    const element = ref.current
    pinnedRef.current = true
    offsetRef.current = 1
    scrolledRef.current = false
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
    // Measured, not assumed: a history read that commits before this call
    // changes the rendered facts without moving `pinnedRef`, reaching the box
    // through this same effect while the panel is still unmounted. The live
    // margin is the only thing that can tell a growing tail from a reader who
    // chose to stand further up.
    pinnedRef.current = withinFollowMargin(element) || !scrolledRef.current
    if (pinnedRef.current) {
      offsetRef.current = 1
      element.scrollTop = element.scrollHeight
      return
    }
    // A reader standing in history gets their place back, not the box's default
    // of 0 — the earliest fact, and the reason this exists at all.
    const top = offsetRef.current * Math.max(0, element.scrollHeight - element.clientHeight)
    element.scrollTop = top
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
