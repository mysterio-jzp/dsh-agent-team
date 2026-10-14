// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { AgentEditorDialog, ModelPickerField } from '../src/client/TeamMemberEditor.tsx'
import { zh } from '../src/client/locales.ts'
import type { TeamModelCatalog } from '../src/client/slots.ts'
import type { AgentTeamClientMemberStatus } from '@contexera/dsh-agent-team/types'

afterEach(cleanup)

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof ModelPickerField>[0]['t']

const CATALOG: TeamModelCatalog = {
  groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
  failures: [],
}

const catalogOk = (): RemoteResult<TeamModelCatalog> => ({ ok: true, value: CATALOG }) as RemoteResult<TeamModelCatalog>
const catalogRefused = (message: string): RemoteResult<TeamModelCatalog> =>
  ({ ok: false, error: { message } }) as RemoteResult<TeamModelCatalog>

function renderPicker(loadModels: () => Promise<RemoteResult<TeamModelCatalog>>) {
  return render(
    <ModelPickerField model={undefined} onModelChange={() => {}} loadModels={loadModels} disabled={false} t={t} />,
  )
}

describe('ModelPickerField catalog load', () => {
  it('renders the trigger once the shared catalog resolves', async () => {
    const loadModels = vi.fn(async () => catalogOk())
    renderPicker(loadModels)
    expect(screen.getByText('正在加载模型目录…')).toBeTruthy()
    expect(await screen.findByRole('button', { name: '模型' })).toBeTruthy()
    expect(screen.queryByText('正在加载模型目录…')).toBeNull()
    expect(loadModels).toHaveBeenCalledTimes(1)
  })

  it('turns a synchronously refused read into a retryable error instead of endless loading', async () => {
    const loadModels = vi.fn((): Promise<RemoteResult<TeamModelCatalog>> => {
      throw new Error('remote.session is unavailable')
    })
    renderPicker(loadModels)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('remote.session is unavailable')
    expect(screen.queryByText('正在加载模型目录…')).toBeNull()
    expect(screen.queryByRole('button', { name: '模型' })).toBeNull()
  })

  it('retries a rejected read and renders the trigger once the retry resolves', async () => {
    const loadModels = vi.fn(async () => catalogOk())
    loadModels.mockRejectedValueOnce(new Error('transport died mid-call'))
    renderPicker(loadModels)
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: '模型' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(loadModels).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight read across concurrent mounts', async () => {
    let resolveLoad!: (result: RemoteResult<TeamModelCatalog>) => void
    const loadModels = vi.fn(() => new Promise<RemoteResult<TeamModelCatalog>>((resolve) => { resolveLoad = resolve }))
    renderPicker(loadModels)
    renderPicker(loadModels)
    await waitFor(() => { expect(loadModels).toHaveBeenCalledTimes(1) })
    resolveLoad(catalogOk())
    expect(await screen.findAllByRole('button', { name: '模型' })).toHaveLength(2)
    expect(loadModels).toHaveBeenCalledTimes(1)
  })

  it('opens with cached rows while revalidating in the background', async () => {
    const loadModels = vi.fn(async () => catalogOk())
    const first = renderPicker(loadModels)
    expect(await screen.findByRole('button', { name: '模型' })).toBeTruthy()
    first.unmount()
    let resolveSecond!: (result: RemoteResult<TeamModelCatalog>) => void
    loadModels.mockImplementationOnce(() => new Promise<RemoteResult<TeamModelCatalog>>((resolve) => { resolveSecond = resolve }))
    renderPicker(loadModels)
    // The revalidation is still pending, yet the warmed rows render at once.
    expect(screen.getByRole('button', { name: '模型' })).toBeTruthy()
    expect(screen.queryByText('正在加载模型目录…')).toBeNull()
    resolveSecond(catalogOk())
    await waitFor(() => { expect(loadModels).toHaveBeenCalledTimes(2) })
    expect(screen.getByRole('button', { name: '模型' })).toBeTruthy()
  })

  it('keeps the answered refusal visible with a retry entry', async () => {
    const loadModels = vi.fn(async () => catalogRefused('catalog unavailable'))
    renderPicker(loadModels)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('catalog unavailable')
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })
})

/**
 * The boundary page's own dialog: the portrait a Human replaces, and the
 * persona file they go and read. Both are drawn from the same Member record the
 * roster reads, so both are asserted against it rather than against the dialog's
 * own idea of who this Member is.
 */
describe('AgentEditorDialog boundary page', () => {
  const member = {
    memberId: 'member:builder', handle: '@builder', description: 'builds', presetId: 'p',
    state: 'enabled', sessionId: 'session:1', avatarRef: 'member-avatar:1',
    agentMdPath: '/host/members/member-builder/agent.md',
  } as unknown as AgentTeamClientMemberStatus['member']

  function open(options: {
    readonly put?: () => Promise<RemoteResult<unknown>>
    readonly remove?: () => Promise<RemoteResult<unknown>>
    readonly update?: () => Promise<RemoteResult<unknown>>
    readonly openPersona?: (path: string) => Promise<string | null>
    readonly member?: AgentTeamClientMemberStatus['member']
  } = {}) {
    const updateMember = vi.fn(options.update ?? (async () => ({ ok: true, value: { member } }) as RemoteResult<unknown>))
    const openMemberPersonaPath = vi.fn(options.openPersona ?? (async () => null))
    render(
      <AgentEditorDialog
        status={{ member: options.member ?? member, availability: 'active' } as AgentTeamClientMemberStatus}
        updateMember={updateMember as never}
        loadModels={async () => catalogOk()}
        putMemberAvatar={vi.fn(options.put ?? (async () => ({ ok: true, value: { avatarRef: 'member-avatar:2' } }) as RemoteResult<unknown>)) as never}
        removeMemberAvatar={vi.fn(options.remove ?? (async () => ({ ok: true, value: { removed: true } }) as RemoteResult<unknown>)) as never}
        memberAvatars={undefined as never}
        openMemberPersonaPath={openMemberPersonaPath as never}
        onCommitted={() => {}}
        onClose={() => {}}
        t={t}
      />,
    )
    return { updateMember, openMemberPersonaPath }
  }

  it('opens the persona path verbatim and says nothing when the Host accepts', async () => {
    const { openMemberPersonaPath } = open()
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }))
    await waitFor(() => { expect(openMemberPersonaPath).toHaveBeenCalledWith('/host/members/member-builder/agent.md') })
    // Accepting is the quiet path: no alert, and the path stays on screen.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('/host/members/member-builder/agent.md')).toBeTruthy()
  })

  it('turns a Host that will not open the file into a readable failure beside the path', async () => {
    const { openMemberPersonaPath } = open({ openPersona: async () => 'no application is registered for .md' })
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('no application is registered for .md')
    // The reader still gets what they came for: the way to the file itself.
    expect(openMemberPersonaPath).toHaveBeenCalledWith('/host/members/member-builder/agent.md')
    expect(screen.getByText('/host/members/member-builder/agent.md')).toBeTruthy()
  })

  it('stores the picture first, then records its reference on the Member', async () => {
    const order: string[] = []
    const { updateMember } = open({
      put: async () => { order.push('put'); return { ok: true, value: { avatarRef: 'member-avatar:2' } } as RemoteResult<unknown> },
      update: async () => { order.push('update'); return { ok: true, value: { member } } as RemoteResult<unknown> },
    })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'face.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(order).toEqual(['put', 'update']) })
    // The reference rides the editor's own update, so the record keeps pointing
    // at bytes that are actually stored.
    await waitFor(() => { expect(updateMember).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'member:builder', avatarRef: 'member-avatar:2' })) })
  })

  it('refuses a non-image before it reaches the Host, and says why', async () => {
    const put = vi.fn(async () => ({ ok: true, value: { avatarRef: 'member-avatar:2' } }) as RemoteResult<unknown>)
    const { updateMember } = open({ put })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } })
    expect((await screen.findByRole('alert')).textContent).toContain('只收图片文件')
    expect(put).not.toHaveBeenCalled()
    expect(updateMember).not.toHaveBeenCalled()
  })

  it('leaves the record alone when the bytes fail to store', async () => {
    const { updateMember } = open({ put: async () => ({ ok: false, error: { message: 'disk full' } }) as RemoteResult<unknown> })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'face.png', { type: 'image/png' })] } })
    expect((await screen.findByRole('alert')).textContent).toContain('disk full')
    // No reference is written, so the Member keeps the face it had.
    expect(updateMember).not.toHaveBeenCalled()
  })

  it('draws no persona row for a Member the projection gave no path', async () => {
    // A Member recorded before the persona file existed still has no path in
    // its projection, and the dialog must not offer a button that cannot work.
    const withoutPath = { ...(member as unknown as Record<string, unknown>) }
    delete withoutPath.agentMdPath
    open({ member: withoutPath as unknown as AgentTeamClientMemberStatus['member'] })
    expect(screen.queryByRole('button', { name: '打开文件' })).toBeNull()
  })
})
