import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readMemberAvatar, removeMemberAvatar, writeMemberAvatar } from '../src/member-avatar.ts'

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.all(tempRoots.map(root => rm(root, { recursive: true, force: true })))
})

describe('member avatar persistent store', () => {
  it('writes, reads, and removes one image entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'member-avatar-'))
    tempRoots.push(root)
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const written = await writeMemberAvatar(root, 'avatar.png', 'image/png', bytes)
    expect(written.avatarRef).toMatch(/^[0-9a-f-]{36}$/)
    const stored = await readMemberAvatar(root, written.avatarRef)
    expect(stored?.mediaType).toBe('image/png')
    expect(stored?.bytes.equals(bytes)).toBe(true)
    await removeMemberAvatar(root, written.avatarRef)
    expect(await readMemberAvatar(root, written.avatarRef)).toBeUndefined()
  })

  it('rejects non-images, empty bytes, and missing entries read as undefined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'member-avatar-'))
    tempRoots.push(root)
    await expect(writeMemberAvatar(root, 'a.txt', 'text/plain', Buffer.from('x'))).rejects.toThrow('must be an image')
    await expect(writeMemberAvatar(root, 'a.png', 'image/png', Buffer.alloc(0))).rejects.toThrow('must not be empty')
    expect(await readMemberAvatar(root, 'missing')).toBeUndefined()
  })

  it('keeps each write immutable, so a second upload never rewrites the first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'member-avatar-'))
    tempRoots.push(root)
    const first = await writeMemberAvatar(root, 'one.png', 'image/png', Buffer.from([0x01]))
    const second = await writeMemberAvatar(root, 'two.png', 'image/png', Buffer.from([0x02]))
    expect(first.avatarRef).not.toBe(second.avatarRef)
    // The seat that still names the old ref keeps drawing the old bytes: this
    // is what lets a Member's face change without every other reader of the
    // previous ref seeing a torn image mid-write.
    expect((await readMemberAvatar(root, first.avatarRef))?.bytes.equals(Buffer.from([0x01]))).toBe(true)
    expect((await readMemberAvatar(root, second.avatarRef))?.bytes.equals(Buffer.from([0x02]))).toBe(true)
  })

  it('removes only the entry named, leaving a sibling ref readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'member-avatar-'))
    tempRoots.push(root)
    const kept = await writeMemberAvatar(root, 'kept.png', 'image/png', Buffer.from([0x0a]))
    const dropped = await writeMemberAvatar(root, 'dropped.png', 'image/png', Buffer.from([0x0b]))
    await removeMemberAvatar(root, dropped.avatarRef)
    expect(await readMemberAvatar(root, dropped.avatarRef)).toBeUndefined()
    expect((await readMemberAvatar(root, kept.avatarRef))?.bytes.equals(Buffer.from([0x0a]))).toBe(true)
  })

  it('treats a removal of an already-missing entry as satisfied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'member-avatar-'))
    tempRoots.push(root)
    await expect(removeMemberAvatar(root, 'never-written')).resolves.toBeUndefined()
  })

  it('stores an avatar whose media type is declared as an opaque octet stream but is not an image is refused', async () => {
    // The Remote defaults an omitted media type to application/octet-stream;
    // that default must not become a way to store a non-image, or the seat
    // would render a blank circle the fallback cannot tell from a decode error.
    const root = await mkdtemp(join(tmpdir(), 'member-avatar-'))
    tempRoots.push(root)
    await expect(writeMemberAvatar(root, 'blob', 'application/octet-stream', Buffer.from([0x01]))).rejects.toThrow('must be an image')
  })
})
