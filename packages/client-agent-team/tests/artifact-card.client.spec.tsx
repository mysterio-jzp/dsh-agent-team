// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { AgentTeamMessageArtifact } from '@contexera/dsh-agent-team/types'
import type { ResourceSnapshot, UseResource } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TeamArtifactCards } from '../src/client/ArtifactCard.tsx'
import { artifactAddress, artifactFailureOf } from '../src/client/artifact-card.ts'
import { createTeamArtifactSeat, type ArtifactRail } from '../src/client/artifact-seat.ts'
import { zh } from '../src/client/locales.ts'
import type { TeamConversationProps } from '../src/client/slots.ts'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as TeamConversationProps['t']

// The artifact belongs to the Member Session that produced it; the reader's own
// Session is where the panel lives. The two are deliberately different, because
// the address must name the producing Session and the open must target the one
// on screen.
// The host stores the path already resolved against the declaring Session, so
// the fixture carries an absolute path — and the address keeps its leading slash
// inside the session segment, which is why the grammar reads as a double slash.
const ARTIFACT: AgentTeamMessageArtifact = { sessionId: 'session:builder' as SessionId, path: '/work/alpha/deliverables/run/report.md' }
const VIEWER = 'session:reader' as SessionId
const ADDRESS = 'dsh-resource://file/session/session:builder//work/alpha/deliverables/run/report.md'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

interface Bench {
  readonly rail: ArtifactRail
  readonly calls: { readonly sessionId: string; readonly address: string }[]
  readonly mountedListeners: Set<() => void>
  setActive(contentId: string): void
}

function bench(mounted: SessionId | undefined): Bench {
  let active: string | undefined
  let expanded = false
  let tabs: { readonly sessionId: SessionId; readonly tabId: never; readonly contentId: string }[] = []
  const calls: { sessionId: string; address: string }[] = []
  const mountedListeners = new Set<() => void>()
  const tabsListeners = new Set<() => void>()
  const rail: ArtifactRail = {
    mounted: {
      getSnapshot: () => mounted,
      subscribe: listener => { mountedListeners.add(listener); return () => { mountedListeners.delete(listener) } },
    },
    openTabs: {
      getSnapshot: () => tabs,
      subscribe: listener => { tabsListeners.add(listener); return () => { tabsListeners.delete(listener) } },
    },
    openResourceIn: (sessionId, address) => {
      calls.push({ sessionId, address })
      active = address
      expanded = true
      tabs = [{ sessionId, tabId: 'tab:artifact' as never, contentId: address }]
      for (const listener of [...tabsListeners]) listener()
    },
    isExpanded: () => expanded,
    toggleExpanded: () => { expanded = !expanded },
    active: () => (active === undefined ? undefined : { contentId: active }),
  }
  return { rail, calls, mountedListeners, setActive: contentId => { active = contentId } }
}

function snapshot(status: ResourceSnapshot<unknown>['status'], code?: string): ResourceSnapshot<unknown> {
  return {
    status,
    value: status === 'live' ? {} : undefined,
    failure: code === undefined ? undefined : ({ code, message: code } as never),
  }
}

function card(useResource: UseResource, rail: ArtifactRail | undefined, artifacts: readonly AgentTeamMessageArtifact[] = [ARTIFACT]) {
  const seat = createTeamArtifactSeat(rail)
  const view = render(<TeamArtifactCards artifacts={artifacts} seat={seat} useResource={useResource} t={t} />)
  return { seat, view }
}

const resourceAt = (state: ResourceSnapshot<unknown>): UseResource => ((_address: string) => state) as unknown as UseResource

describe('Team message artifact cards', () => {
  it('names the file, opens the producing Session\'s copy in the reader\'s panel, and marks it current', async () => {
    const b = bench(VIEWER)
    const { view } = card(resourceAt(snapshot('live')), b.rail)
    const button = view.getByRole('button', { name: zh.artifactOpenOne.replace('{title}', 'report.md') })
    expect(button.getAttribute('aria-current')).toBeNull()
    fireEvent.click(button)
    // The open targets the Session on screen (that is where a tab can be placed)
    // and the address names the Session that wrote the file (that is where the
    // Host reads it) — mixing the two up is the defect this pins.
    expect(b.calls).toEqual([{ sessionId: VIEWER, address: ADDRESS }])
    expect(b.calls[0]?.address).not.toContain(VIEWER)
    await waitFor(() => { expect(button.getAttribute('aria-current')).toBe('true') })
  })

  it('reads the file through the shipped provider and refuses the click while the state is unknown', () => {
    const b = bench(VIEWER)
    const { view } = card(resourceAt(snapshot('loading')), b.rail)
    const item = view.container.querySelector('[data-artifact-state]')
    expect(item?.getAttribute('data-artifact-state')).toBe('loading')
    const button = view.getByRole('button')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(view.getByText(zh.artifactLoading)).toBeDefined()
    fireEvent.click(button)
    expect(b.calls).toEqual([])
  })

  it('shows no registered provider as a readable failure with a copy-path exit', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { view } = card(resourceAt(snapshot('none')), bench(VIEWER).rail)
    expect(view.container.querySelector('[data-artifact-state]')?.getAttribute('data-artifact-state')).toBe('failed')
    expect(view.getByText(zh.artifactUnreadableHeadline)).toBeDefined()
    expect(view.getByText(zh.artifactUnreadableDetail)).toBeDefined()
    expect(view.getByRole('button', { name: zh.artifactCopyPath })).toBeDefined()
    const cardButton = view.container.querySelector<HTMLButtonElement>('[data-artifact-address]')!
    expect(cardButton.disabled).toBe(false)
    fireEvent.click(view.getByRole('button', { name: zh.artifactCopyPath }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(ARTIFACT.path) })
  })

  it('keeps "the file is gone" and "outside the workspace" as different words and ways out', () => {
    const missing = card(resourceAt(snapshot('failed', 'workspace-file/not-found')), bench(VIEWER).rail).view
    expect(missing.container.querySelector('[data-artifact-state]')?.getAttribute('data-artifact-state')).toBe('failed')
    expect(missing.getByText(zh.artifactMissingHeadline)).toBeDefined()
    expect(missing.getByText(zh.artifactMissingDetail)).toBeDefined()
    expect(missing.getByText(zh.artifactMissingTitle.replace('{name}', 'report.md'))).toBeDefined()
    cleanup()
    const outside = card(resourceAt(snapshot('failed', 'workspace-file/outside-workspace')), bench(VIEWER).rail).view
    expect(outside.getByText(zh.artifactOutsideHeadline)).toBeDefined()
    expect(outside.queryByText(zh.artifactMissingHeadline)).toBeNull()
  })

  it('answers a rail with no Session on screen with a readable failure instead of a silent click', () => {
    const b = bench(undefined)
    const { view } = card(resourceAt(snapshot('live')), b.rail)
    fireEvent.click(view.getByRole('button'))
    expect(b.calls).toEqual([])
    expect(view.container.querySelector('[data-artifact-state]')?.getAttribute('data-artifact-state')).toBe('failed')
    expect(view.getByText(zh.artifactNoSessionHeadline)).toBeDefined()
    expect(view.getByText(zh.artifactNoSessionDetail)).toBeDefined()
  })

  it('answers a shell that never provided the rail the same way, without throwing', () => {
    const view = card(resourceAt(snapshot('live')), undefined).view
    fireEvent.click(view.getByRole('button'))
    expect(view.getByText(zh.artifactNoSessionHeadline)).toBeDefined()
  })

  it('drops the current mark when the panel moves to another file', async () => {
    const b = bench(VIEWER)
    const { view } = card(resourceAt(snapshot('live')), b.rail)
    const button = view.getByRole('button')
    fireEvent.click(button)
    await waitFor(() => { expect(button.getAttribute('aria-current')).toBe('true') })
    // The rail hides its active tab behind `active()` rather than an observable,
    // so a switch reaches the seat as the interaction that caused it.
    b.setActive('dsh-resource://file/session/session:reader/other.md')
    fireEvent.pointerDown(document.body)
    await waitFor(() => { expect(button.getAttribute('aria-current')).toBeNull() })
  })

  it('closes on Escape, clears current, and returns focus to the triggering card', async () => {
    const b = bench(VIEWER)
    const { view } = card(resourceAt(snapshot('live')), b.rail)
    const button = view.getByRole('button')
    fireEvent.click(button)
    await waitFor(() => { expect(button.getAttribute('aria-current')).toBe('true') })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => { expect(button.getAttribute('aria-current')).toBeNull() })
    expect(b.rail.isExpanded()).toBe(false)
    expect(document.activeElement).toBe(button)
  })

  it('returns focus when the right-rail close control collapses after click', async () => {
    const b = bench(VIEWER)
    const { view } = card(resourceAt(snapshot('live')), b.rail)
    const trigger = view.getByRole('button')
    fireEvent.click(trigger)
    await waitFor(() => { expect(trigger.getAttribute('aria-current')).toBe('true') })
    const close = document.createElement('button')
    view.container.appendChild(close)
    close.addEventListener('click', () => { b.rail.toggleExpanded() })
    fireEvent.click(close)
    await waitFor(() => { expect(trigger.getAttribute('aria-current')).toBeNull() })
    expect(b.rail.isExpanded()).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('copies the path when the file cannot be read', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const view = card(resourceAt(snapshot('failed', 'workspace-file/not-found')), bench(VIEWER).rail).view
    fireEvent.click(view.getByRole('button', { name: zh.artifactCopyPath }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(ARTIFACT.path) })
    await waitFor(() => { expect(view.getByRole('button', { name: zh.artifactPathCopied })).toBeDefined() })
  })

  it('draws nothing at all for a Message that carries no artifact', () => {
    const view = card(resourceAt(snapshot('live')), bench(VIEWER).rail, []).view
    expect(view.container.querySelector('[data-artifacts]')).toBeNull()
    expect(view.container.textContent).toBe('')
  })

  it('builds the address from the artifact\'s own Session', () => {
    expect(artifactAddress(ARTIFACT)).toBe(ADDRESS)
    // An absolute path keeps its leading slash inside the session segment: the
    // address names the path as recorded, and the Host resolves it against the
    // Session root (reporting `outside-workspace` rather than guessing a root).
    expect(artifactAddress({ sessionId: 'session:other' as SessionId, path: '/tmp/x.txt' })).toBe('dsh-resource://file/session/session:other//tmp/x.txt')
  })
})

describe('artifact failure vocabulary', () => {
  it('maps the shipped file provider\'s codes, and keeps the rest unreadable', () => {
    expect(artifactFailureOf('workspace-file/not-found')).toBe('missing')
    expect(artifactFailureOf('workspace-file/outside-workspace')).toBe('outside-workspace')
    expect(artifactFailureOf('workspace-file/unknown-workspace')).toBe('session-gone')
    expect(artifactFailureOf('workspace-file/too-large')).toBe('unreadable')
    expect(artifactFailureOf(undefined)).toBe('unreadable')
  })
})
