// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useTimelineScroll } from '../src/client/timeline-scroll.ts'

// A stand-in for the Thread timeline: jsdom lays nothing out, so the box's own
// scroll range is installed here and `scrollTop` is recorded as it is written.
function timelineBox(): HTMLDivElement {
  const box = document.createElement('div')
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => 2000 })
  Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => 400 })
  return box
}

describe('timeline return to the Thread view', () => {
  const written: number[] = []
  const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  afterEach(() => {
    written.length = 0
    if (originalScrollTop === undefined) delete (Element.prototype as { scrollTop?: unknown }).scrollTop
    else Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop)
  })

  it('parks a returning reader on the latest fact instead of the earliest one', () => {
    // Leaving the Thread view unmounts the scrolling panel; coming back mounts a
    // fresh box at its default `scrollTop` of 0, the oldest fact. The policy
    // re-establishes the follow position the reader left with.
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element): number { return 0 },
      set(this: Element, value: number): void { written.push(value) },
    })
    const { result } = renderHook(() => useTimelineScroll('same-content'))
    // The box the panel would mount; the policy only ever reads and writes it.
    ;(result.current.ref as { current: HTMLElement | null }).current = timelineBox()

    result.current.returnToTimeline()

    expect(written).toEqual([2000])
    expect(result.current.isPinned()).toBe(true)
  })

  it('leaves a reader who left at an older fact at the same place down the discussion', () => {
    // The reader scrolled up to read history before switching views. Returning
    // must not undo their position by yanking the box to the bottom.
    let top = 0
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element): number {
        if (this instanceof HTMLElement && this.dataset.reader === 'true') return top
        return 0
      },
      set(this: Element, value: number): void {
        written.push(value)
        if (this instanceof HTMLElement && this.dataset.reader === 'true') top = value
      },
    })
    const { result } = renderHook(() => useTimelineScroll('same-content'))
    const box = timelineBox()
    box.dataset.reader = 'true'
    ;(result.current.ref as { current: HTMLElement | null }).current = box
    // A 200px offset inside a 400px-tall box over 2000px of content is far from
    // the bottom margin, so the reader is browsing history, not following it.
    top = 200
    result.current.onScroll()

    result.current.returnToTimeline()

    // 200px into a 1600px range is an eighth of the way down; the returning box
    // has the same range here, so the reader lands back on their own fact
    // instead of the box's default 0, which would be the earliest one.
    expect(written).toEqual([200])
    expect(top).toBe(200)
    expect(result.current.isPinned()).toBe(false)
  })

  it('keeps following a tail that grew while the reader was away in the checklist', () => {
    // The other half of the same mechanism: a Thread read committed while the
    // panel was unmounted renders new facts, so the box comes back further from
    // its bottom than the reader left it. That is growth under a reader who was
    // following, not a reader who chose to stand up in history — returning must
    // still land on the latest fact.
    let top = 0
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element): number { return this instanceof HTMLElement && this.dataset.reader === 'true' ? top : 0 },
      set(this: Element, value: number): void {
        written.push(value)
        if (this instanceof HTMLElement && this.dataset.reader === 'true') top = value
      },
    })
    const { result } = renderHook(() => useTimelineScroll('same-content'))
    const before = timelineBox()
    before.dataset.reader = 'true'
    ;(result.current.ref as { current: HTMLElement | null }).current = before
    // Following the tail before leaving: 1600 is the limit of a 400px-tall box
    // over 2000px of content.
    top = 1600
    result.current.onScroll()
    // The panel unmounts; the next read lands four more facts, so the content
    // the reader returns to is 600px longer than the one they left.
    ;(result.current.ref as { current: HTMLElement | null }).current = null
    const after = timelineBox()
    Object.defineProperty(after, 'scrollHeight', { configurable: true, get: () => 2600 })
    after.dataset.reader = 'true'
    ;(result.current.ref as { current: HTMLElement | null }).current = after

    result.current.returnToTimeline()

    expect(written).toEqual([2600])
    expect(result.current.isPinned()).toBe(true)
  })
})
