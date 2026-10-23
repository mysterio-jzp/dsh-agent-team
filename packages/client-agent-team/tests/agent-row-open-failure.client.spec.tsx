// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

describe('Team Channel Session row opens', () => {
  it('reports a rejected Channel Session open without switching the seat', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const channelSessionId = 'session:builder-eng'
    await b.view.findByText('builder')
    b.publishChannelUpdate()
    await new Promise(resolve => setTimeout(resolve, 30))
    b.members.mockImplementation(async () => ({
      ok: true,
      value: [{
        ...b.status('member:builder', 'w1', 'builder', 'available'),
        channels: [{ channelRef: 'channel:engineering', channelName: 'engineering', state: 'ready', activity: 'normal', sessionId: channelSessionId }],
      }],
    } as never))
    b.publishChannelUpdate()
    const agent = await b.view.findByRole('button', { name: '展开/收起 builder 的频道' })
    fireEvent.click(agent)
    const channelList = await b.view.findByRole('list', { name: 'builder 的频道' })
    b.openSession.mockImplementation(() => {
      throw new Error(`sessions.retain: unknown session ${channelSessionId}`)
    })
    fireEvent.click(within(channelList).getByRole('button', { name: /engineering/ }))
    const alert = await b.view.findByRole('alert')
    expect(alert.textContent).toContain(`sessions.retain: unknown session ${channelSessionId}`)
    expect(b.openSession).toHaveBeenCalledWith(channelSessionId)
    await b.runtime.dispose()
  })

  it('opens the Channel row Session rather than a Member-owned Session', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const channelSessionId = 'session:builder-eng'
    await b.view.findByText('builder')
    await b.runtime.sessions.add({ id: channelSessionId as never, summary: { title: 'engineering', cwd: '/work/alpha' } } as never)
    b.publishChannelUpdate()
    await new Promise(resolve => setTimeout(resolve, 30))
    b.members.mockImplementation(async () => ({
      ok: true,
      value: [{
        ...b.status('member:builder', 'w1', 'builder', 'available'),
        channels: [{ channelRef: 'channel:engineering', channelName: 'engineering', state: 'ready', activity: 'normal', sessionId: channelSessionId }],
      }],
    } as never))
    b.publishChannelUpdate()
    const agent = await b.view.findByRole('button', { name: '展开/收起 builder 的频道' })
    fireEvent.click(agent)
    const channelList = await b.view.findByRole('list', { name: 'builder 的频道' })
    fireEvent.click(within(channelList).getByRole('button', { name: /engineering/ }))
    await waitFor(() => expect(b.openSession).toHaveBeenCalledWith(channelSessionId))
    expect(b.openSession).not.toHaveBeenCalledWith('session:member:builder')
    expect(b.view.queryByRole('alert')).toBeNull()
    await b.runtime.dispose()
  })
})
