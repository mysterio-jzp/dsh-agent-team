// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** Stands in for the shipped plugin manager's global panel (main key 'plugins'). */
function ShippedPluginPage() { return <div data-shipped-plugins>插件</div> }

/**
 * Team mode owns no panel: the mode's seat is the `main` shadow registered under
 * the reserved 'conversation' key, and `teamNavigation.mode` is the one
 * criterion that says whether that seat stands. The shell renders one keyed main
 * panel — `activePanelId ?? 'conversation'` — so the mode keeps that selection
 * clear, which is also what keeps the right rail drawn beside the Team page
 * (`RightbarRoot` hides it whenever a panel is selected). A global panel the
 * Human selected still owns the column, and taking it ends the mode.
 */
describe('Team mode and the shell main panel', () => {
  it('yields a restored Team mode to a global panel already selected at mount', async () => {
    const b = await runtimeWithTeam({ mode: 'team', mainPanelId: 'plugins', workspaceId: 'w1' })
    // The panel owns the column, so the restored mode stands down rather than
    // covering the page the reader left open.
    await waitFor(() => expect(b.runtime.ctx.teamNavigation.getSnapshot().mode).toBe('conversation'))
    expect(b.panelInfo.getSnapshot().activePanelId).toBe('plugins')
  })

  it('takes the column back from a global panel and keeps the seat clear', async () => {
    const b = await runtimeWithTeam({})
    b.runtime.slots.register({ name: 'main', key: 'plugins' }, ShippedPluginPage as never)
    await act(async () => { b.selectPanel('plugins') })
    expect(await b.view.findByText('插件')).toBeTruthy()

    // The entry is the shell's own button in the sidebar's foot: it clears the
    // panel and flips the mode, so the column belongs to the conversation seat
    // the Team stands in for — never to a panel of the Team's own.
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))

    await waitFor(() => expect(b.runtime.ctx.teamNavigation.getSnapshot().mode).toBe('team'))
    expect(b.panelInfo.getSnapshot().activePanelId).toBeNull()
    expect(b.view.container.querySelector('[data-shipped-plugins]')).toBeNull()
  })

  it('keeps the seat clear while the mode navigates inside itself', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    // The Team's own overview stands in the column through the mode's seat.
    expect(await b.view.findByRole('button', { name: '# engineering' })).toBeTruthy()

    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))

    // A Team destination is not a panel: the mode says which destination the
    // column belongs to, and the selection stays clear underneath it.
    await waitFor(() => expect(b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy())
    expect(b.panelInfo.getSnapshot().activePanelId).toBeNull()
    expect(b.runtime.ctx.teamNavigation.getSnapshot().mode).toBe('team')
  })

  it('leaves no panel selected across a whole stay in the mode', async () => {
    const b = await runtimeWithTeam({})
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await waitFor(() => expect(b.runtime.ctx.teamNavigation.getSnapshot().mode).toBe('team'))
    // The mode's seat is the `conversation` key the shell falls back to, so
    // nothing is selected while it stands — the precondition `RightbarRoot`
    // reads to keep drawing the right rail's Session content beside the page.
    expect(b.panelInfo.getSnapshot().activePanelId).toBeNull()

    fireEvent.click(b.view.getByRole('button', { name: '对话' }))
    await waitFor(() => expect(b.runtime.ctx.teamNavigation.getSnapshot().mode).toBe('conversation'))
    expect(b.panelInfo.getSnapshot().activePanelId).toBeNull()
  })
})
