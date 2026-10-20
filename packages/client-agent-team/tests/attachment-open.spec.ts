import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamAttachmentId, AgentTeamGetAttachmentRequest, AgentTeamGetAttachmentResult } from '@contexera/dsh-agent-team/types'
import { attachmentFileAddress, openAttachmentInSidebar, type AttachmentReadRemote, type AttachmentSidebar } from '../src/client/attachment-open.ts'

const attachment = { attachmentId: 'attachment:abc' as AgentTeamAttachmentId }
const stored: AgentTeamGetAttachmentResult = {
  name: 'notes.txt',
  mediaType: 'text/plain',
  byteSize: 4,
  bytesBase64: 'dGVzdA==',
  path: '/Users/human/.dsh/attachments/attachment/abc/notes.txt',
  uploadedAt: '2026-10-20T03:00:00.000Z',
}

/**
 * A sidebar that records addresses and reports one on-screen Session.
 *
 * `open` also appends to the tab record, because a real Sidebar's `open` has
 * no return value: the record is the only way a caller learns whether the
 * address was taken.
 */
function sidebar(overrides: Partial<AttachmentSidebar> = {}): AttachmentSidebar & { opened: string[] } {
  const opened: string[] = []
  const tabs: { sessionId?: string; contentId?: string }[] = []
  return {
    opened,
    mounted: () => 'session-1',
    // One tab per address, like the real rail: opening the same file again
    // focuses the tab that is already there instead of adding another.
    open: (address: string) => {
      opened.push(address)
      if (!tabs.some(tab => tab.contentId === address)) tabs.push({ sessionId: 'session-1', contentId: address })
    },
    openTabs: () => tabs,
    ...overrides,
  }
}

/** A read remote answering with one result, or throwing. */
function remote(result: unknown): AttachmentReadRemote {
  return { getAttachment: vi.fn(async (_request: AgentTeamGetAttachmentRequest) => result) } as unknown as AttachmentReadRemote
}

describe('attachment address', () => {
  it('builds a session-scoped address, because that is the only scope a viewer claims', () => {
    // `dsh-resource://file/absolute/...` is not claimed by any shipped viewer;
    // a session-scoped address is, and the path stays absolute inside it
    // because the cache lives outside every workspace.
    expect(attachmentFileAddress('session-1', '/Users/human/.dsh/cache/notes.txt'))
      .toBe('dsh-resource://file/session/session-1//Users/human/.dsh/cache/notes.txt')
  })

  it('keeps a drive letter literal and encodes what would break the address', () => {
    expect(attachmentFileAddress('session-1', 'C:\\Users\\a b\\notes #1.txt'))
      .toBe('dsh-resource://file/session/session-1/C:/Users/a%20b/notes%20%231.txt')
  })
})

describe('opening an attachment', () => {
  it('does not touch the Host when no Session is on screen', async () => {
    const read = remote({ ok: true, value: stored })
    await expect(openAttachmentInSidebar(sidebar({ mounted: () => undefined }), read, attachment)).resolves.toBe('no-session')
    expect(read.getAttachment).not.toHaveBeenCalled()
  })

  it('opens the Host-resolved path in the on-screen Session', async () => {
    const face = sidebar()
    await expect(openAttachmentInSidebar(face, remote({ ok: true, value: stored }), attachment)).resolves.toBeNull()
    expect(face.opened).toEqual(['dsh-resource://file/session/session-1//Users/human/.dsh/attachments/attachment/abc/notes.txt'])
  })

  it('says the copy is gone only on the stable code, so the reader knows to ask for a re-send', async () => {
    const read = remote({
      ok: false,
      error: new RemoteError('team/attachment-not-found', 'no longer cached', { attachmentId: attachment.attachmentId }),
    })
    await expect(openAttachmentInSidebar(sidebar(), read, attachment)).resolves.toBe('expired')
  })

  it('keeps a Host refusal distinct from a gone copy', async () => {
    const read = remote({ ok: false, error: new Error('boom') })
    await expect(openAttachmentInSidebar(sidebar(), read, attachment)).resolves.toBe('refused')
  })

  it('treats an unreachable Host as a refusal, not as a missing file', async () => {
    const read = { getAttachment: vi.fn(async () => { throw new Error('offline') }) } as unknown as AttachmentReadRemote
    await expect(openAttachmentInSidebar(sidebar(), read, attachment)).resolves.toBe('refused')
  })

  it('reports an unconfirmed open as unknown, not as a named cause', async () => {
    // A Session that is on screen but never adopted makes the real `open`
    // record nothing and raise nothing. Reporting success would leave the
    // block saying "Opening…" forever; reporting `no-session` would state a
    // cause this call never learned. The honest answer is that it could not
    // be confirmed.
    const face = sidebar({ open: () => {} })
    await expect(openAttachmentInSidebar(face, remote({ ok: true, value: stored }), attachment)).resolves.toBe('unknown')
  })

  it('opens an attachment that already has a tab without calling that a failure', async () => {
    // The rail focuses an existing tab instead of adding one, so the tab count
    // stays the same on a second click. Keying the check on the count read
    // that ordinary gesture as "no Session on screen".
    const face = sidebar()
    await expect(openAttachmentInSidebar(face, remote({ ok: true, value: stored }), attachment)).resolves.toBeNull()
    await expect(openAttachmentInSidebar(face, remote({ ok: true, value: stored }), attachment)).resolves.toBeNull()
    expect(face.openTabs()).toHaveLength(1)
  })

  it('reports unsupported when no Sidebar type claims the address', async () => {
    const face = sidebar({ open: () => { throw new Error('no type claims') } })
    await expect(openAttachmentInSidebar(face, remote({ ok: true, value: stored }), attachment)).resolves.toBe('unsupported')
  })
})
