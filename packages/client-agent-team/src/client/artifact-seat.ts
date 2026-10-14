/**
 * The seat between an artifact card and the shipped right rail.
 *
 * The Team Client owns no panel and no file reader of its own: it asks the
 * rail to place the shipped `file` tab (`openResourceIn`) and asks the rail
 * what its active pane currently shows (`active`). Both calls act on the
 * Session on screen, which is the Session this Client's rail is bound to; the
 * address keeps naming the artifact's own producing Session, so the file is
 * read where it was written.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentTeamMessageArtifact } from '@contexera/dsh-agent-team/types'
import { artifactAddress, type ArtifactFailure } from './artifact-card.ts'

/** One open tab as the rail reports it; only what a card compares against. */
export interface ArtifactRailTab {
  readonly sessionId: SessionId
  readonly tabId: TabId
  readonly contentId: string
}

/**
 * The slice of `ctx.sidebarRight` this seat uses. Structural on purpose: the
 * card depends only on the rail's navigation, visibility, and tab inventory.
 */
export interface ArtifactRail {
  /** The Session on screen, or `undefined` while none is. */
  readonly mounted: ObservableSnapshot<SessionId | undefined>
  /** Open tab metadata, which changes when a tab is opened or closed. */
  readonly openTabs: ObservableSnapshot<readonly ArtifactRailTab[]>
  /** Open a resource into one named Session's rail. */
  openResourceIn(sessionId: SessionId, address: string): void
  /** Whether the right panel is currently expanded. */
  isExpanded(): boolean
  /** Collapse the expanded right panel. */
  toggleExpanded(): void
  /** The active tab of the active pane, or `undefined` with no Session on screen. */
  active(): { readonly contentId: string } | undefined
}

/** What an artifact card asks of the shell. */
export interface TeamArtifactSeat {
  /**
   * Place the artifact's file in the right rail.
   * @param artifact - the artifact the reader clicked.
   * @param trigger - the card that should regain focus when this preview closes.
   * @returns `undefined` once the rail took it, or why nothing opened.
   */
  open(artifact: AgentTeamMessageArtifact, trigger?: HTMLElement | undefined): ArtifactFailure | undefined
  /** Collapse this seat's currently active artifact preview, if any. */
  closePreview(returnFocus?: boolean): boolean
  /** The address currently shown by the expanded right panel. */
  currentAddress(): string | undefined
  /** Whether the right panel currently shows this address. */
  isCurrent(address: string): boolean
  /** Subscribe to what the panel shows. */
  subscribeCurrent(listener: () => void): () => void
  /** Detach every listener this seat owns. */
  dispose(): void
}

/** The document slice the seat watches for tab switches; absent outside a browser. */
interface TabSwitchTarget {
  addEventListener(type: string, listener: EventListener, capture: boolean): void
  removeEventListener(type: string, listener: EventListener, capture: boolean): void
}

/**
 * Build the seat one Client mounts for its Team conversation.
 *
 * `aria-current` follows the expanded rail's active tab, and the right rail
 * publishes the active record only as a read (`active()`), not as an observable.
 * The seat re-reads after rail commits and user interactions. It also owns the
 * source-card focus handoff because the shell does not know which Team card
 * opened a resource.
 * @param rail - the shipped right-rail face, or `undefined` while the shell has not provided it.
 * @param target - the document carrying the rail's tab strip; defaults to `document`.
 * @returns the seat, whose listeners attach on the first subscriber and detach on the last.
 */
export function createTeamArtifactSeat(rail: ArtifactRail | undefined, target?: TabSwitchTarget | undefined): TeamArtifactSeat {
  const doc = target ?? (typeof document === 'undefined' ? undefined : document)
  const listeners = new Set<() => void>()
  let current: string | undefined
  let triggerAddress: string | undefined
  let triggerElement: HTMLElement | undefined
  let restoreFocusOnClose = true
  let wasExpanded = rail?.isExpanded() === true
  let attached = false
  let teardown: readonly (() => void)[] = []

  const finishTrigger = (restoreFocus: boolean): void => {
    const trigger = triggerElement
    triggerAddress = undefined
    triggerElement = undefined
    restoreFocusOnClose = true
    if (restoreFocus && trigger?.isConnected === true) trigger.focus({ preventScroll: true })
  }

  const recompute = (): void => {
    const sessionId = rail?.mounted.getSnapshot()
    const expanded = sessionId !== undefined && rail?.isExpanded() === true
    const tabs = rail?.openTabs.getSnapshot() ?? []
    const triggerStillOpen = triggerAddress === undefined || (sessionId !== undefined
      && tabs.some(tab => tab.sessionId === sessionId && tab.contentId === triggerAddress))
    if ((wasExpanded && !expanded) || !triggerStillOpen) finishTrigger(restoreFocusOnClose)
    wasExpanded = expanded
    const next = expanded ? rail?.active()?.contentId : undefined
    if (next === current) return
    current = next
    for (const listener of [...listeners]) listener()
  }

  const collapsePreview = (returnFocus: boolean): boolean => {
    const sessionId = rail?.mounted.getSnapshot()
    if (sessionId === undefined || rail?.isExpanded() !== true || triggerAddress === undefined || current !== triggerAddress) return false
    restoreFocusOnClose = returnFocus
    try {
      rail.toggleExpanded()
    } catch (_unavailable) {
      restoreFocusOnClose = true
      return false
    }
    recompute()
    if (rail.isExpanded()) {
      restoreFocusOnClose = true
      return false
    }
    return true
  }

  // A rail toggle may commit its collapsed state after the input handler. Read
  // once after dispatch and once in the next task so focus returns after the DOM settles.
  const afterInteraction: EventListener = () => {
    queueMicrotask(recompute)
    setTimeout(recompute, 0)
  }
  const onEscape: EventListener = event => {
    const key = event as KeyboardEvent
    if (key.key !== 'Escape' || key.defaultPrevented || key.isComposing || key.repeat
      || key.altKey || key.ctrlKey || key.metaKey || key.shiftKey) return
    if (!collapsePreview(true)) return
    key.preventDefault()
  }
  const attach = (): void => {
    const detach: (() => void)[] = []
    if (rail !== undefined) detach.push(rail.mounted.subscribe(recompute), rail.openTabs.subscribe(recompute))
    if (doc !== undefined) {
      doc.addEventListener('pointerdown', afterInteraction, true)
      doc.addEventListener('keydown', afterInteraction, true)
      doc.addEventListener('click', afterInteraction, true)
      doc.addEventListener('keydown', onEscape, false)
      detach.push(() => {
        doc.removeEventListener('pointerdown', afterInteraction, true)
        doc.removeEventListener('keydown', afterInteraction, true)
        doc.removeEventListener('click', afterInteraction, true)
        doc.removeEventListener('keydown', onEscape, false)
      })
    }
    teardown = detach
    recompute()
  }
  const detach = (): void => {
    for (const undo of teardown) undo()
    teardown = []
  }

  return {
    open(artifact, trigger) {
      // `openResourceIn` leaves an unadopted Session alone, and `openResource`
      // throws when nothing is on screen: both are silent from the reader's
      // side, so the guard is read here and answered with words.
      const sessionId = rail?.mounted.getSnapshot()
      if (rail === undefined || sessionId === undefined) return 'no-session'
      const address = artifactAddress(artifact)
      try {
        rail.openResourceIn(sessionId, address)
      } catch (_unopenable) {
        // The factory throws for an address no registered type accepts — a
        // wiring mistake, not a user error. The reader still clicked a card and
        // got nothing, so it surfaces as a readable failure with a way out
        // (the path is on the card), never as a silent no-op.
        return 'unreadable'
      }
      recompute()
      if (rail.isExpanded() !== true || rail.active()?.contentId !== address) return 'unreadable'
      triggerAddress = address
      triggerElement = trigger
      restoreFocusOnClose = true
      return undefined
    },
    closePreview(returnFocus = true) {
      return collapsePreview(returnFocus)
    },
    currentAddress() {
      return current
    },
    isCurrent(address) {
      return current === address
    },
    subscribeCurrent(listener) {
      listeners.add(listener)
      if (!attached) {
        attached = true
        attach()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && attached) {
          attached = false
          detach()
        }
      }
    },
    dispose() {
      attached = false
      detach()
      listeners.clear()
      triggerAddress = undefined
      triggerElement = undefined
    },
  }
}
