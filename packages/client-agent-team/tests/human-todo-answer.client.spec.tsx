// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

vi.setConfig({ testTimeout: 30_000 })
usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

type Bench = Awaited<ReturnType<typeof runtimeWithTeam>>
const todo = {
  todoRef: 'todo:1', workspaceId: 'w1', channelRef: 'channel:1', threadRef: 'thread:1',
  title: '确认发布顺序', state: 'pending', requester: 'member:builder',
}
const input = (b: Bench) => b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
const edit = (b: Bench, body: string) => fireEvent.change(input(b), { target: { value: body } })
const submit = (b: Bench) => fireEvent.click(b.view.getByRole('button', { name: '发送' }))
const idle = (b: Bench) => b.view.findByRole('button', { name: '发送' })

async function answeringThread(): Promise<Bench> {
  const b = await runtimeWithTeam({
    mode: 'team', workspaceId: 'w1', initialChannels: true,
    seededMessages: [{ body: '发布安排', occurredAt: '2026-08-21T09:00:00.000Z' }],
    seedThreadMembers: [{ memberId: 'member:builder', following: true }],
  })
  b.seedHumanTodos([todo])
  fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
  fireEvent.click(await b.view.findByRole('button', { name: '打开 Task #1' }))
  fireEvent.click(await b.view.findByRole('tab', { name: /待办/ }))
  fireEvent.click(await b.view.findByRole('button', { name: '在讨论里回复…' }))
  return b
}

async function closeFromFeed(b: Bench, state: 'closed' | 'cancelled' = 'closed'): Promise<void> {
  fireEvent.click(b.view.getByRole('tab', { name: /待办/ }))
  b.seedHumanTodos(state === 'cancelled' ? [] : [{ ...todo, state }])
  await waitFor(() => {
    const card = b.view.container.querySelector('[data-todo-card="todo:1"]')
    if (state === 'cancelled') expect(card).toBeNull()
    else expect(card?.getAttribute('data-state')).toBe('closed')
  })
  fireEvent.click(b.view.getByRole('tab', { name: /讨论/ }))
}

async function send(b: Bench, body: string): Promise<void> {
  edit(b, body)
  submit(b)
  await waitFor(() => expect(input(b).value).toBe(''))
  await idle(b)
}

describe('Human to-do answer lifecycle', () => {
  it('binds a successful answer once and never binds the following ordinary messages', async () => {
    const b = await answeringThread()
    await send(b, '先发布服务端')
    expect(b.changeHumanTodo).toHaveBeenCalledTimes(1)
    expect(b.changeHumanTodo).toHaveBeenCalledWith(expect.objectContaining({
      action: 'answer', todoRef: 'todo:1', messageRef: 'message:human-reply',
    }))
    await closeFromFeed(b)
    await send(b, '接下来讨论其他问题')
    await send(b, '再补充一条普通消息')
    expect(b.reply).toHaveBeenCalledTimes(3)
    expect(b.changeHumanTodo).toHaveBeenCalledTimes(1)
    expect(b.view.queryByRole('alert')).toBeNull()
    await b.runtime.dispose()
  })

  it('keeps the answer target for a normal retry after a failed send', async () => {
    const b = await answeringThread()
    b.reply.mockResolvedValueOnce({ ok: false, error: { message: 'send failed' } } as never)
    edit(b, '先发布服务端')
    submit(b)
    expect((await b.view.findByRole('alert')).textContent).toContain('send failed')
    await idle(b)
    expect(b.changeHumanTodo).not.toHaveBeenCalled()
    expect(input(b).value).toBe('先发布服务端')
    submit(b)
    await waitFor(() => expect(input(b).value).toBe(''))
    await idle(b)
    expect(b.reply).toHaveBeenCalledTimes(2)
    expect(b.changeHumanTodo).toHaveBeenCalledTimes(1)
    expect(b.view.queryByRole('alert')).toBeNull()
    await b.runtime.dispose()
  })

  it.each(['unread_required', 'stale_revision'] as const)('keeps the live answer target across a %s send fence', async kind => {
    const b = await answeringThread()
    b.reply.mockResolvedValueOnce({ ok: true, value: { kind, unreadCount: 1 } } as never)
    edit(b, '先发布服务端')
    submit(b)
    await b.view.findByRole('alert')
    await idle(b)
    expect(b.changeHumanTodo).not.toHaveBeenCalled()
    expect(input(b).value).toBe('先发布服务端')
    submit(b)
    await waitFor(() => expect(input(b).value).toBe(''))
    await idle(b)
    expect(b.changeHumanTodo).toHaveBeenCalledTimes(1)
    await b.runtime.dispose()
  })

  it('keeps the live answer target when a checklist refresh fails', async () => {
    const b = await answeringThread()
    const read = b.humanTodos.getMockImplementation()!
    b.humanTodos.mockImplementation(async request => request.threadRef === 'thread:1'
      ? { ok: false, error: { message: 'todo read unavailable' } } as never
      : read(request))
    b.publishWorkspaceUpdate()
    expect((await b.view.findByRole('alert')).textContent).toContain('todo read unavailable')
    b.humanTodos.mockImplementation(read)
    await send(b, '读取失败并不代表待办已结案')
    expect(b.changeHumanTodo).toHaveBeenCalledTimes(1)
    await b.runtime.dispose()
  })

  it.each(['closed', 'cancelled'] as const)('does not carry a %s to-do from an abandoned answer onto an ordinary message', async state => {
    const b = await answeringThread()
    b.reply.mockResolvedValueOnce({ ok: false, error: { message: 'send failed' } } as never)
    edit(b, '先发布服务端')
    submit(b)
    expect((await b.view.findByRole('alert')).textContent).toContain('send failed')
    await idle(b)
    await closeFromFeed(b, state)
    b.changeHumanTodo.mockResolvedValueOnce({ ok: false, error: { message: `Human todo 'todo:1' is already ${state}` } } as never)
    await send(b, '这是一条普通消息')
    expect(b.changeHumanTodo).not.toHaveBeenCalled()
    expect(b.view.queryByRole('alert')).toBeNull()
    await b.runtime.dispose()
  })

  it('respects a terminal update that arrives while the answer reply is in flight', async () => {
    const b = await answeringThread()
    const commit = b.reply.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    b.reply.mockImplementationOnce(async request => { await gate; return commit(request) })
    edit(b, '先发布服务端')
    submit(b)
    await waitFor(() => expect(b.reply).toHaveBeenCalledTimes(1))
    await closeFromFeed(b)
    release()
    await waitFor(() => expect(input(b).value).toBe(''))
    await idle(b)
    expect(b.changeHumanTodo).not.toHaveBeenCalled()
    expect(b.view.queryByRole('alert')).toBeNull()
    await b.runtime.dispose()
  })

  it.each(['refused', 'transport'] as const)('reports a %s binding separately from a committed message and never retries it on the next send', async failure => {
    const b = await answeringThread()
    const reason = failure === 'refused' ? "Human todo 'todo:1' is already closed" : 'binding transport unavailable'
    if (failure === 'transport') b.changeHumanTodo.mockRejectedValueOnce(new Error(reason))
    else b.changeHumanTodo.mockResolvedValueOnce({ ok: false, error: { message: reason } } as never)
    await send(b, '先发布服务端')
    expect(b.view.queryByRole('alert')).toBeNull()
    expect(b.view.getByText(text => text.includes('消息已发送') && text.includes(reason)).getAttribute('role')).toBe('status')
    await send(b, '这是一条普通消息')
    expect(b.changeHumanTodo).toHaveBeenCalledTimes(1)
    expect(b.view.queryByRole('alert')).toBeNull()
    expect(b.view.queryByText(text => text.includes('消息已发送') && text.includes(reason))).toBeNull()
    await b.runtime.dispose()
  })
})
