// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

/** 0.1.7 selection read: the conversation follows the session holding the workspace service's `mainView` reference. */
function mainViewSessionId(b: Awaited<ReturnType<typeof runtimeWithTeam>>): string | undefined {
  return Object.values(b.runtime.sessions.list.getSnapshot().byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

async function reportBuilderChannels(b: Awaited<ReturnType<typeof runtimeWithTeam>>, channels: readonly Record<string, unknown>[], presence: 'available' | 'unavailable' = 'available'): Promise<void> {
  b.publishChannelUpdate()
  await new Promise(resolve => setTimeout(resolve, 30))
  b.members.mockImplementation(async () => ({
    ok: true,
    value: [{ ...b.status('member:builder', 'w1', 'builder', presence), channels }],
  } as never))
  b.publishChannelUpdate()
  await waitFor(() => { expect(b.view.getByRole('button', { name: '展开/收起 builder 的频道' })).toBeTruthy() })
}

async function openBuilderChannelSession(b: Awaited<ReturnType<typeof runtimeWithTeam>>, channelName: RegExp = /engineering/): Promise<void> {
  const agent = b.view.getByRole('button', { name: '展开/收起 builder 的频道' })
  if (agent.getAttribute('aria-expanded') !== 'true') fireEvent.click(agent)
  const list = await b.view.findByRole('list', { name: 'builder 的频道' })
  fireEvent.click(within(list).getByRole('button', { name: channelName }))
}

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

describe('Team agent surfaces', () => {
  it('imports a global Member without copying it, retries the same join, and withdraws only here', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w2' })
    await b.view.findByText('builder')
    const trigger = b.view.getByRole('button', { name: '添加 Agent' })
    fireEvent.click(trigger)
    fireEvent.click(b.view.getByRole('button', { name: '从其他 Workspace 引入' }))
    const dialog = await b.view.findByRole('dialog', { name: '添加 Agent' })
    const worker = (await within(dialog).findByText('@worker')).closest('[data-team-member-row]') as HTMLElement
    expect(within(dialog).getAllByRole('button', { name: '引入' })).toHaveLength(4)
    const held = Promise.withResolvers<Awaited<ReturnType<typeof b.joinWorkspace>>>()
    b.joinWorkspace.mockReturnValueOnce(held.promise)
    fireEvent.click(within(worker).getByRole('button', { name: '引入' }))
    expect(within(worker).getByRole('button', { name: '引入中…' }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.view.getByRole('dialog', { name: '添加 Agent' })).toBeTruthy()
    held.resolve({ ok: false, error: { message: 'join connection lost' } } as never)
    expect((await within(dialog).findByRole('alert')).textContent).toContain('join connection lost')
    fireEvent.click(within(worker).getByRole('button', { name: '引入' }))
    await waitFor(() => expect(b.view.queryByRole('dialog')).toBeNull())
    expect(await b.view.findByText('worker')).toBeTruthy()
    expect(b.joinWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ memberId: 'member:worker', workspaceId: 'w2' }))
    expect(b.joinWorkspace.mock.calls[0]![0]).toEqual(b.joinWorkspace.mock.calls[1]![0])
    expect(b.addMember).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    fireEvent.click(b.view.getByRole('button', { name: 'worker 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '从此 Workspace 撤回' }))
    const confirmation = await b.view.findByRole('dialog', { name: '撤回 worker？' })
    expect(confirmation.textContent).toContain('其他 Workspace 的工作')
    expect(b.leaveWorkspace).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: '从此 Workspace 撤回' }))
    await waitFor(() => expect(b.view.queryByText('worker')).toBeNull())
    expect(b.leaveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'member:worker', workspaceId: 'w2' }))
    expect(b.archiveMember).not.toHaveBeenCalled()
    expect((await b.members({ workspaceId: 'w1' })).value.some(row => row.member.memberId === 'member:worker')).toBe(true)
    await b.runtime.dispose()
  })

  it('shows import loading, read failure with retry, and a truthful empty state', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await b.view.findByText('builder')
    // Suspended Members are importable too: joining does not depend on
    // availability. The import roster shows them with their paused state.
    fireEvent.click(b.view.getByRole('button', { name: '添加 Agent' }))
    const suspended = { ...b.status('member:paused', 'w2', 'paused', 'unavailable'), workspaceIds: ['w2'] }
    Object.assign(suspended.member, { state: 'suspended' })
    b.members.mockResolvedValueOnce({ ok: true, value: [suspended] } as never)
    fireEvent.click(b.view.getByRole('button', { name: '从其他 Workspace 引入' }))
    const dialog = b.view.getByRole('dialog', { name: '添加 Agent' })
    expect(await within(dialog).findByText('@paused')).toBeTruthy()
    // The failure line replaces the roster without masquerading as empty.
    const held = Promise.withResolvers<Awaited<ReturnType<typeof b.members>>>()
    b.members.mockReturnValueOnce(held.promise)
    fireEvent.click(within(dialog).getByRole('button', { name: '创建 Agent' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '从其他 Workspace 引入' }))
    held.resolve({ ok: false, error: { message: 'catalog offline' } } as never)
    expect((await within(dialog).findByRole('alert')).textContent).toContain('catalog offline')
    expect(within(dialog).queryByText('没有可引入的 Agent。')).toBeNull()
    // Retry issues a fresh read: an empty catalog renders the true empty state.
    b.members.mockResolvedValueOnce({ ok: true, value: [] })
    fireEvent.click(within(dialog).getByRole('button', { name: '重试' }))
    expect(await within(dialog).findByText('没有可引入的 Agent。')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(b.view.queryByRole('dialog')).toBeNull())
    await b.runtime.dispose()
  })

  it('warns about other participations before global archive and preserves the dialog on failure', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await b.joinWorkspace({ memberId: 'member:worker', workspaceId: 'w2' })
    await b.view.findByText('worker')
    fireEvent.click(b.view.getByRole('button', { name: 'worker 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档' }))
    const dialog = await b.view.findByRole('dialog', { name: '归档 Agent：worker' })
    expect(dialog.textContent).toContain('其他 1 个 Workspace')
    b.archiveMember.mockResolvedValueOnce({ ok: false, error: { message: 'archive offline' } } as never)
    fireEvent.click(within(dialog).getByRole('button', { name: '归档' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('archive offline')
    fireEvent.click(within(dialog).getByRole('button', { name: '归档' }))
    await waitFor(() => expect(b.view.queryByText('worker')).toBeNull())
    expect(b.archiveMember.mock.calls[0]![0]).toEqual(b.archiveMember.mock.calls[1]![0])
    expect(b.leaveWorkspace).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })

  it('renders agent rows draggable with the saved personal order folded in', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await waitFor(() => expect(b.view.container.querySelectorAll('[draggable="true"]').length).toBeGreaterThanOrEqual(4))
    const rows = b.view.container.querySelectorAll('[draggable="true"]')
    for (const row of rows) expect(row.querySelector('[class*="agentSelect"]')).not.toBeNull()
    await b.runtime.dispose()
  })

  it('keeps the sidebar presence badge outside the avatar clipping seat', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await waitFor(() => expect(b.view.container.querySelectorAll('[draggable="true"]').length).toBeGreaterThanOrEqual(4))
    const row = b.view.container.querySelector('[data-agent-row]')
    expect(row).not.toBeNull()
    const avatar = row!.querySelector('[data-avatar-size="24"]')
    const badge = row!.querySelector('[class*="agentAvatarBadge"]')
    expect(avatar).not.toBeNull()
    expect(badge).not.toBeNull()
    expect(badge?.parentElement).toBe(avatar?.parentElement)
    expect(avatar?.contains(badge)).toBe(false)
    await b.runtime.dispose()
  })

  it('enters Team with existing Workspaces and restores the shipped seats', async () => {
    const b = await runtimeWithTeam()
    expect(b.view.getByText('普通工作区')).toBeTruthy()
    // The conversation seat carries the shipped ConversationRoot; its
    // resident [data-composer-seat] node stands in for the old baseline text.
    expect(b.view.container.querySelector('[data-composer-seat]')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await waitFor(() => expect(document.documentElement.dataset.agentTeamMode).toBe('team'))
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    expect(await b.view.findByRole('heading', { name: '频道' })).toBeTruthy()
    expect(b.view.getAllByText('Alpha')).toHaveLength(2)
    expect(b.view.queryByText('设置')).toBeNull()
    const membersTrigger = b.view.getByRole('button', { name: '成员' })
    const delayedMembers = Promise.withResolvers<Awaited<ReturnType<typeof b.members>>>()
    b.members.mockReturnValueOnce(delayedMembers.promise)
    fireEvent.click(membersTrigger)
    const membersDialog = await b.view.findByRole('dialog', { name: '成员' })
    expect(within(membersDialog).getByRole('status').textContent).toContain('正在加载 Agent')
    delayedMembers.resolve({ ok: true, value: [b.status('member:builder', 'w1', 'builder', 'available')] } as never)
    await waitFor(() => expect(within(membersDialog).getAllByText('@builder')).toHaveLength(2))
    expect(within(membersDialog).getByText('Alpha')).toBeTruthy()
    expect(within(membersDialog).getByText('Beta')).toBeTruthy()
    const membersContent = membersDialog.querySelector('[tabindex="-1"]')
    await waitFor(() => expect(document.activeElement).toBe(membersContent))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.view.queryByRole('dialog', { name: '成员' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(membersTrigger))
    b.members.mockRejectedValueOnce(new Error('members transport failed'))
    fireEvent.click(membersTrigger)
    expect((await b.view.findByRole('alert')).textContent).toContain('members transport failed')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(membersTrigger))

    fireEvent.click(b.view.getByRole('button', { name: '对话' }))
    await waitFor(() => expect(document.documentElement.dataset.agentTeamMode).toBeUndefined())
    expect(await b.view.findByText('普通工作区')).toBeTruthy()
    expect(b.view.container.querySelector('[data-composer-seat]')).toBeTruthy()
    expect(await b.view.findByText('设置')).toBeTruthy()
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    await b.runtime.dispose()
  })

  it('loads Workspace Agents and creates a durable Member without optimistic rows', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    expect(await b.view.findByText('从左侧选择一个频道开始协作')).toBeTruthy()

    expect(await b.view.findByText('builder')).toBeTruthy()
    expect(b.view.getByRole('img', { name: '可用' })).toBeTruthy()
    expect(b.view.getByRole('img', { name: '工作中' })).toBeTruthy()
    expect(b.view.getByRole('img', { name: '错误: model failed' })).toBeTruthy()
    expect(b.view.getByRole('img', { name: '不可用: preset missing' })).toBeTruthy()
    expect(b.members).toHaveBeenCalledWith({ workspaceId: 'w1' })

    const addAgentTrigger = b.view.getByRole('button', { name: '添加 Agent' })
    fireEvent.click(addAgentTrigger)
    expect(b.view.getByRole('dialog', { name: '添加 Agent' })).toBeTruthy()
    const agentName = b.view.getByLabelText('名称')
    await waitFor(() => expect(document.activeElement).toBe(agentName))
    fireEvent.change(agentName, { target: { value: 'reviewer' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'Reviews changes' } })
    // Creation has no Channel page: the Member joins Channels later from the
    // Channel side and stays reachable through its DM view meanwhile.
    expect(b.view.queryByRole('button', { name: /初始频道/ })).toBeNull()
    b.addMember.mockResolvedValueOnce({ ok: false, error: { message: 'connection lost' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '创建 Agent' }))
    expect((await b.view.findByRole('alert')).textContent).toContain('connection lost')
    expect((b.view.getByLabelText('名称') as HTMLInputElement).value).toBe('reviewer')
    expect(b.view.queryByText('reviewer')).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: '创建 Agent' }))

    expect(await b.view.findByText('reviewer')).toBeTruthy()
    expect(b.addMember).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'w1', channelRefs: [], handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member',
    }))
    expect(b.addMember.mock.calls[0]![0].requestId).toBe(b.addMember.mock.calls[1]![0].requestId)
    await waitFor(() => expect(document.activeElement).toBe(addAgentTrigger))
    fireEvent.click(addAgentTrigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.view.queryByRole('dialog', { name: '添加 Agent' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(addAgentTrigger))
    await b.runtime.dispose()
  })

  it('creates an Agent with empty description, no Channels, and an optional model', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')
    fireEvent.click(b.view.getByRole('button', { name: '添加 Agent' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'bare' } })
    // Description stays optional; the hint shows an example instead of saying so.
    expect(b.view.getByPlaceholderText('例如：负责后端接口与数据模型')).toBeTruthy()
    // Pick a model through the capped menu; pinning reveals the effort row.
    fireEvent.click(await b.view.findByRole('button', { name: '模型' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: 'DeepSeek Chat' }))
    fireEvent.click(b.view.getByRole('button', { name: /推理强度/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: 'high' }))
    // No Channel picker exists at creation; Channels join later from the Channel side.
    expect(b.view.queryByText('选择初始频道')).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: '创建 Agent' }))
    expect(await b.view.findByText('bare')).toBeTruthy()
    expect(b.addMember).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'w1', handle: 'bare', description: '', presetId: 'team-member', channelRefs: [],
      model: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' },
    }))
    await b.runtime.dispose()
  })

  it('creates a Channel atomically with selected enabled Members and manages committed membership', async () => {
    const b = await runtimeWithTeam()
    const builderWithoutChannel = b.status('member:builder', 'w1', 'builder', 'unavailable')
    const suspended = b.status('member:offline', 'w1', 'offline', 'unavailable')
    Object.assign(suspended.member, { state: 'suspended' })
    b.members.mockImplementation(async () => ({ ok: true, value: [builderWithoutChannel, suspended] } as never))
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    expect(await b.view.findByText('还没有频道')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'backend' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'API implementation' } })
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    const unavailable = await within(document.body).findByRole('menuitem', { name: /offline/ }) as HTMLButtonElement
    expect(unavailable.disabled).toBe(true)
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    b.createChannel.mockResolvedValueOnce({ ok: false, error: { message: 'connection lost' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    expect((await b.view.findByRole('alert')).textContent).toContain('connection lost')
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))

    expect(await b.view.findByText('# backend')).toBeTruthy()
    expect(b.createChannel).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'w1', name: 'backend', description: 'API implementation', memberIds: ['member:builder'],
    }))
    expect(b.createChannel.mock.calls[0]![0].requestId).toBe(b.createChannel.mock.calls[1]![0].requestId)
    // Membership is derived from participation now, so a created Channel has
    // no membership controls to drive.
    fireEvent.click(b.view.getByRole('button', { name: '# backend' }))
    expect(b.view.queryByRole('button', { name: '管理成员' })).toBeNull()
    await b.runtime.dispose()
  })

  it('renames Channel display facts from the editor and refreshes the row', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    expect(await b.view.findByText('# engineering')).toBeTruthy()

    fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑频道' }))
    const editor = b.view.getByRole('dialog', { name: '编辑频道' })
    // Save stays disabled until something actually changes.
    expect(((within(editor).getByRole('button', { name: '保存' }) as HTMLButtonElement)).disabled).toBe(true)
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'platform' } })
    fireEvent.change(within(editor).getByLabelText(/说明/), { target: { value: 'Infrastructure work' } })
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.updateChannel).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w1', channelRef: 'channel:engineering', name: 'platform', description: 'Infrastructure work',
    })) })
    // The committed rename rides the projection refresh, not an optimistic row edit.
    expect(await b.view.findByText('# platform')).toBeTruthy()
    expect(b.view.queryByText('# engineering')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('offers 恢复 and 重启 in the row menu only where they apply and routes both through the Host remote', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    // A healthy Member's menu carries only the editor entry.
    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    const healthyMenu = await within(document.body).findByRole('menu')
    expect(within(healthyMenu).getByRole('menuitem', { name: '编辑 Agent' })).toBeTruthy()
    expect(within(healthyMenu).queryAllByRole('menuitem', { name: '恢复' })).toEqual([])
    expect(within(healthyMenu).queryAllByRole('menuitem', { name: '重启' })).toEqual([])
    // The error Member additionally gets the recovery entry.
    fireEvent.click(b.view.getByRole('button', { name: 'failed 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '恢复' }))
    await waitFor(() => {
      expect(b.recoverMember).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', memberId: 'member:failed' }))
    })
    // The unavailable Member gets the restart entry for a failed activation.
    fireEvent.click(b.view.getByRole('button', { name: 'offline 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '重启' }))
    await waitFor(() => {
      expect(b.recoverMember).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', memberId: 'member:offline' }))
    })
    // A restart that leaves the Member unavailable surfaces the diagnostic on the row.
    const alert = await b.view.findByRole('alert')
    expect(alert.textContent).toContain('重启已执行，成员仍不可用：preset missing')
    // A transport rejection surfaces as the row alert too.
    b.recoverMember.mockRejectedValueOnce(new Error('connection lost'))
    fireEvent.click(b.view.getByRole('button', { name: 'offline 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '重启' }))
    await waitFor(() => { expect(b.view.getByRole('alert').textContent).toContain('重启执行失败：connection lost') })
    await b.runtime.dispose()
  })

  it('retires the manual clear-context action and follows a Channel rollover exactly once', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    // The manual clear-context row action is retired: every Member menu omits it.
    for (const handle of ['builder', 'worker', 'failed', 'offline']) {
      fireEvent.click(b.view.getByRole('button', { name: `${handle} 的操作` }))
      const menu = await within(document.body).findByRole('menu')
      expect(within(menu).queryByRole('menuitem', { name: '从全新上下文开始' })).toBeNull()
      fireEvent.keyDown(document, { key: 'Escape' })
    }

    const previousSessionId = 'session:builder-eng'
    const nextSessionId = 'session:builder-eng-next'
    await b.runtime.sessions.add({ id: previousSessionId as never, summary: { title: 'engineering', cwd: '/work/alpha' } } as never)
    await b.runtime.sessions.add({ id: nextSessionId as never, summary: { title: 'engineering', cwd: '/work/alpha' } } as never)
    await reportBuilderChannels(b, [{ channelRef: 'channel:engineering', channelName: 'engineering', state: 'ready', sessionId: previousSessionId }])
    await openBuilderChannelSession(b)
    expect(b.openSession).toHaveBeenCalledWith(previousSessionId)

    // A Channel-domain binding rollover follows the selected session once.
    await reportBuilderChannels(b, [{ channelRef: 'channel:engineering', channelName: 'engineering', state: 'ready', sessionId: nextSessionId }])
    await waitFor(() => expect(b.openSession.mock.calls.filter(([id]) => id === nextSessionId)).toHaveLength(1))
    b.publishChannelUpdate()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(b.openSession.mock.calls.filter(([id]) => id === nextSessionId)).toHaveLength(1)
    await b.runtime.dispose()
  })

  it('edits Agent identity and pins a Member model through the editor', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑 Agent' }))
    const editor = b.view.getByRole('dialog', { name: '编辑 Agent' })
    // The Host catalog arrives session-independently; the picker rides the
    // shared Menu primitive with the default entry leading each open.
    const modelTrigger = await within(editor).findByRole('button', { name: '模型' })
    await waitFor(() => { expect(modelTrigger.textContent).toContain('跟随全局默认') })
    fireEvent.click(modelTrigger)
    const modelMenu = within(document.body).getByRole('menu')
    expect(within(modelMenu).getByText('DeepSeek')).toBeTruthy()
    fireEvent.click(within(modelMenu).getByRole('menuitem', { name: 'DeepSeek Reasoner' }))
    await waitFor(() => { expect(modelTrigger.textContent).toContain('DeepSeek Reasoner') })
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'architect' } })
    fireEvent.change(within(editor).getByLabelText(/说明/), { target: { value: 'System design owner' } })
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.updateMember).toHaveBeenCalledWith(expect.objectContaining({
      memberId: 'member:builder', handle: 'architect', description: 'System design owner',
      model: { provider: 'deepseek-official', model: 'deepseek-reasoner' },
    })) })
    // The renamed handle reaches the roster through the refreshed projection.
    expect(await b.view.findByText('architect')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('shows a newly saved Member avatar in the sidebar from the upload cache', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    try {
      await b.view.findByText('builder')
      expect(b.view.container.querySelector('[data-agent-row] [data-avatar-size="24"]')?.getAttribute('data-avatar')).toBe('initial')
      fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
      fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑 Agent' }))
      const editor = b.view.getByRole('dialog', { name: '编辑 Agent' })
      const picker = editor.querySelector('input[type="file"]') as HTMLInputElement
      fireEvent.change(picker, { target: { files: [new File(['avatar-bytes'], 'avatar.png', { type: 'image/png' })] } })
      await waitFor(() => expect(b.updateMember).toHaveBeenCalledWith(expect.objectContaining({
        memberId: 'member:builder', avatarRef: 'member-avatar:1',
      })))
      await waitFor(() => expect(editor.querySelector('[data-avatar-size="64"]')?.getAttribute('data-avatar')).toBe('image'))
      await waitFor(() => expect(b.view.container.querySelector('[data-agent-row] [data-avatar-size="24"]')?.getAttribute('data-avatar')).toBe('image'))
      expect(b.getMemberAvatar).not.toHaveBeenCalledWith({ avatarRef: 'member-avatar:1' })
    } finally {
      await b.runtime.dispose()
    }
  })

  it('keeps Agent rows from opening Member Sessions and opens the Channel-domain Session', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    const memberSessionId = 'session:member:builder'
    const channelSessionId = 'session:builder-eng'
    await b.runtime.sessions.add({ id: memberSessionId as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    await b.runtime.sessions.add({ id: channelSessionId as never, summary: { title: 'engineering', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')

    // A Member without Channel rows is not an entry point to its legacy personal Session.
    const memberRow = b.view.container.querySelector('[data-agent-row] [class*="agentSelect"]') as HTMLButtonElement
    expect(memberRow.disabled).toBe(true)
    fireEvent.click(memberRow)
    expect(b.openSession).not.toHaveBeenCalledWith(memberSessionId)

    await reportBuilderChannels(b, [{ channelRef: 'channel:engineering', channelName: 'engineering', state: 'ready', sessionId: channelSessionId }])
    await openBuilderChannelSession(b)
    await waitFor(() => expect(b.openSession).toHaveBeenCalledWith(channelSessionId))
    expect(b.openSession).not.toHaveBeenCalledWith(memberSessionId)
    await b.runtime.dispose()
  })

  it('returns from a Channel Session to Inbox without reopening a disposed id', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    const channelSessionId = 'session:builder-eng'
    await b.runtime.sessions.add({ id: channelSessionId as never, summary: { title: 'engineering', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')
    await reportBuilderChannels(b, [{ channelRef: 'channel:engineering', channelName: 'engineering', state: 'ready', sessionId: channelSessionId }])

    const entry = b.view.getByRole('button', { name: /^收件箱/ })
    fireEvent.click(entry)
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-inbox]')).toBeTruthy() })
    await waitFor(() => { expect(entry.getAttribute('aria-current')).toBe('page') })

    await openBuilderChannelSession(b)
    await waitFor(() => expect(b.openSession).toHaveBeenCalledWith(channelSessionId))
    await b.runtime.sessions.remove(channelSessionId)

    // Returning to the Team page must not resurrect the disposed Channel Session.
    fireEvent.click(entry)
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-inbox]')).toBeTruthy() })
    expect(entry.getAttribute('aria-current')).toBe('page')
    expect(b.openSession.mock.calls.filter(([id]) => id === channelSessionId)).toHaveLength(1)
    await b.runtime.dispose()
  })

  it('returns from a Channel Session to its page without a blank seat after disposal', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    const channelSessionId = 'session:builder-eng'
    await b.runtime.sessions.add({ id: channelSessionId as never, summary: { title: 'engineering', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')
    await reportBuilderChannels(b, [{ channelRef: 'channel:engineering', channelName: 'engineering', state: 'ready', sessionId: channelSessionId }])
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))

    await openBuilderChannelSession(b)
    await waitFor(() => { expect(mainViewSessionId(b)).toBe(channelSessionId) })

    // Returning to the Channel page restores the ordinary selection once;
    // disposing the former Channel Session cannot blank or remount its seat.
    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-channel]')).toBeTruthy() })
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    expect(b.openSession.mock.calls.filter(([id]) => id === 'ordinary-session')).toHaveLength(1)
    const seat = b.view.container.querySelector('[data-team-channel]') as HTMLElement

    await b.runtime.sessions.remove(channelSessionId)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    expect(b.view.container.querySelector('[data-team-channel]')).toBe(seat)
    expect(b.view.getByRole('heading', { name: '# engineering' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('keeps the Channel Session when its return target is gone without reopening the dead id', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    const channelSessionId = 'session:builder-eng'
    await b.runtime.sessions.add({ id: channelSessionId as never, summary: { title: 'engineering', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')
    await reportBuilderChannels(b, [{ channelRef: 'channel:engineering', channelName: 'engineering', state: 'ready', sessionId: channelSessionId }])
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    await openBuilderChannelSession(b)
    await waitFor(() => { expect(mainViewSessionId(b)).toBe(channelSessionId) })

    // The Human's ordinary return target disappears while the Channel Session is selected.
    await b.runtime.sessions.remove('ordinary-session')
    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-channel]')).toBeTruthy() })
    expect(mainViewSessionId(b)).toBe(channelSessionId)
    expect(b.openSession.mock.calls.filter(([id]) => id === channelSessionId)).toHaveLength(1)
    expect(b.openSession).not.toHaveBeenCalledWith('ordinary-session')
    await b.runtime.dispose()
  })

  it('edits Agent facts without a Channel membership section', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑 Agent' }))
    const editor = b.view.getByRole('dialog', { name: '编辑 Agent' })
    // Channel membership is managed from the Channel side: the editor carries
    // only handle, description, and model.
    expect(within(editor).queryByRole('button', { name: '添加' })).toBeNull()
    expect(within(editor).queryByRole('button', { name: '移除' })).toBeNull()
    expect(within(editor).queryByText(/频道成员/)).toBeNull()
    expect(within(editor).getByLabelText('名称')).toBeTruthy()
    fireEvent.change(within(editor).getByLabelText(/说明/), { target: { value: 'Edited description' } })
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.updateMember).toHaveBeenCalledWith(expect.objectContaining({
      memberId: 'member:builder', handle: 'builder', description: 'Edited description',
    })) })
    await waitFor(() => expect(b.view.queryByRole('dialog', { name: '编辑 Agent' })).toBeNull())
    await b.runtime.dispose()
  })

  it('toggles an Agent channel session list open on click and closed on second click', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    await b.runtime.sessions.add({ id: 'session:member:builder' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')

    b.publishChannelUpdate()
    await new Promise(resolve => setTimeout(resolve, 30))
    b.members.mockImplementation(async () => ({
      ok: true,
      value: [{
        ...b.status('member:builder', 'w1', 'builder', 'available'),
        channels: [
          { channelRef: 'channel:engineering', channelName: 'engineering', state: 'ready', sessionId: 'session:builder-eng' },
        ],
      }],
    } as never))
    b.publishChannelUpdate()

    const agentButton = await waitFor(() => {
      const btn = b.view.getByRole('button', { name: '展开/收起 builder 的频道' })
      expect(btn.getAttribute('aria-expanded')).toBe('false')
      return btn
    })
    expect(b.view.queryByRole('list', { name: 'builder 的频道' })).toBeNull()

    fireEvent.click(agentButton)
    expect(agentButton.getAttribute('aria-expanded')).toBe('true')
    expect(b.openSession).not.toHaveBeenCalled()
    const channelList = b.view.getByRole('list', { name: 'builder 的频道' })
    expect(within(channelList).getByRole('button', { name: /engineering/ })).toBeTruthy()

    fireEvent.click(agentButton)
    expect(agentButton.getAttribute('aria-expanded')).toBe('false')
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.view.queryByRole('list', { name: 'builder 的频道' })).toBeNull()

    await b.runtime.dispose()
  })

  it('renders each channel row status indicator and the presence the Host rolled up from them', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    await b.view.findByText('builder')

    b.publishChannelUpdate()
    await new Promise(resolve => setTimeout(resolve, 30))

    // Case 1: the Host reports `working` because one Channel Session runs.
    b.members.mockImplementation(async () => ({
      ok: true,
      value: [{
        ...b.status('member:builder', 'w1', 'builder', 'working'),
        channels: [
          { channelRef: 'channel:eng', channelName: 'engineering', state: 'ready', activity: 'normal', sessionId: 'session:builder-eng' },
          { channelRef: 'channel:ops', channelName: 'ops', state: 'ready', activity: 'running', sessionId: 'session:builder-ops' },
        ],
      }],
    } as never))
    b.publishChannelUpdate()

    const agentButton = await waitFor(() => {
      const btn = b.view.getByRole('button', { name: '展开/收起 builder 的频道' })
      expect(b.view.getByRole('img', { name: '工作中' })).toBeTruthy()
      return btn
    })
    fireEvent.click(agentButton)
    const channelList = b.view.getByRole('list', { name: 'builder 的频道' })
    expect(channelList.querySelector('[data-channel-row-status="normal"]')).not.toBeNull()
    expect(channelList.querySelector('[data-channel-row-status="running"]')).not.toBeNull()
    expect(within(channelList).queryByText('就绪')).toBeNull()
    expect(within(channelList).queryByText('创建中')).toBeNull()

    // Case 2: a warning row makes the Host report `error`, which outranks `working`.
    b.members.mockImplementation(async () => ({
      ok: true,
      value: [{
        ...b.status('member:builder', 'w1', 'builder', 'error'),
        channels: [
          { channelRef: 'channel:eng', channelName: 'engineering', state: 'ready', activity: 'normal', sessionId: 'session:builder-eng' },
          { channelRef: 'channel:ops', channelName: 'ops', state: 'ready', activity: 'running', sessionId: 'session:builder-ops' },
          { channelRef: 'channel:broken', channelName: 'broken', state: 'unopenable', activity: 'warning', reason: 'origin-unrecorded' },
        ],
      }],
    } as never))
    b.publishChannelUpdate()

    await waitFor(() => {
      expect(b.view.getByRole('img', { name: '错误' })).toBeTruthy()
    })
    expect(channelList.querySelector('[data-channel-row-status="warning"]')).not.toBeNull()
    expect(within(channelList).queryByText('无法打开')).toBeNull()

    await b.runtime.dispose()
  })

})

describe('Team archival surfaces', () => {
  it('archives an Agent from the row menu behind a destructive confirm', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    // The danger entry sits in every Member's row menu.
    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档' }))
    expect(b.view.getByRole('dialog', { name: '归档 Agent：builder' })).toBeTruthy()
    // The notice states the recoverability contract: data kept, no restore
    // entry point yet.
    expect(b.view.getByRole('dialog', { name: '归档 Agent：builder' }).textContent).toContain('暂无恢复入口')
    expect(b.archiveMember).not.toHaveBeenCalled()
    // Cancel closes without routing.
    fireEvent.click(b.view.getByRole('button', { name: '取消' }))
    expect(b.view.queryByRole('dialog', { name: '归档 Agent：builder' })).toBeNull()
    expect(b.archiveMember).not.toHaveBeenCalled()
    // Confirm routes the durable archive; the archived state arrives through
    // the workspace refetch and the row disappears.
    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档' }))
    fireEvent.click(await b.view.findByRole('button', { name: /^归档$/ }))
    await waitFor(() => {
      expect(b.archiveMember).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'member:builder' }))
    })
    await b.publishChannelUpdate()
    await waitFor(() => expect(b.view.queryByRole('button', { name: 'builder 的操作' })).toBeNull())
    await b.runtime.dispose()
  })

  it('replaces the rail empty claims with one error line when the connection drops', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const readChannels = b.viewChannels.getMockImplementation()!
    const readMembers = b.members.getMockImplementation()!
    await b.view.findByText('还没有频道')
    // The opening probe consumes the first publish silently, so the second one
    // is what refreshes the mounted Panels — here with an emptied roster.
    b.publishChannelUpdate()
    b.members.mockResolvedValue({ ok: true, value: [] } as never)
    b.publishChannelUpdate()
    await b.view.findByText('还没有 Agent')

    // The Host connection drops: each Panel reports the failure on the rail,
    // and a failed load must not additionally read as an empty workspace. The
    // reads fail too, exactly as they do when the transport is gone.
    b.viewChannels.mockResolvedValue({ ok: false, error: { message: 'transport down' } } as never)
    b.members.mockResolvedValue({ ok: false, error: { message: 'transport down' } } as never)
    b.failChanges()
    expect((await b.view.findAllByText('transport down')).length).toBeGreaterThanOrEqual(2)
    expect(b.view.queryByText('还没有频道')).toBeNull()
    expect(b.view.queryByText('还没有 Agent')).toBeNull()

    // The transport returns and the wake that follows carries a new version:
    // the still-mounted rail drops the error line and picks up the Channel
    // created while it was cut off — no remount, no page reload.
    b.seedChannel({ channelRef: 'channel:recovery', workspaceId: 'w1', name: 'recovery', description: 'created while cut off', createdAtSequence: 2 })
    b.viewChannels.mockImplementation(readChannels)
    b.members.mockImplementation(readMembers)
    b.recoverChanges()
    await b.view.findByRole('button', { name: '# recovery' })
    expect(b.view.queryByText('transport down')).toBeNull()
    await b.runtime.dispose()
  })

  it('archives a Channel from the row menu behind a destructive confirm', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('# engineering')

    fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档频道' }))
    expect(b.view.getByRole('dialog', { name: '归档频道：engineering' })).toBeTruthy()
    expect(b.view.getByRole('dialog', { name: '归档频道：engineering' }).textContent).toContain('暂无恢复入口')
    expect(b.archiveChannel).not.toHaveBeenCalled()
    fireEvent.click(b.view.getByRole('button', { name: '取消' }))
    expect(b.view.queryByRole('dialog', { name: '归档频道：engineering' })).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档频道' }))
    fireEvent.click(await b.view.findByRole('button', { name: /^归档频道$/ }))
    await waitFor(() => {
      expect(b.archiveChannel).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', channelRef: 'channel:engineering' }))
    })
    await b.publishChannelUpdate()
    await waitFor(() => expect(b.view.queryByRole('button', { name: 'engineering 的操作' })).toBeNull())
    await b.runtime.dispose()
  })
})

describe('Team member editor partial update payload', () => {
  it('states the model explicitly and leaves capabilities alone', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')
    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑 Agent' }))
    const editor = b.view.getByRole('dialog', { name: '编辑 Agent' })
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'architect' } })
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.updateMember).toHaveBeenCalled() })
    const payload = b.updateMember.mock.calls.at(-1)?.[0]
    // "Follow global default" is an explicit clear now; an omitted field would
    // keep a stuck pin. Capabilities stay out: an absent field no longer clears.
    expect(payload?.model).toBeNull()
    expect(payload).not.toHaveProperty('capabilities')
  })
})
