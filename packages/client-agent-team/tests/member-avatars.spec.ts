import { describe, expect, it, vi } from 'vitest'
import { TeamMemberAvatars } from '../src/client/member-avatars.ts'

describe('TeamMemberAvatars', () => {
  it('keeps a seeded avatar when an older read rejects later', async () => {
    const oldRead = Promise.withResolvers<string | null>()
    const loadAvatarUrl = vi.fn(() => oldRead.promise)
    const avatars = new TeamMemberAvatars({ loadAvatarUrl })
    const changed = vi.fn()
    avatars.subscribe(changed)
    const avatarRef = 'member-avatar:1'
    const seededUrl = 'data:image/png;base64,c2VlZGVk'

    try {
      expect(avatars.getSnapshot(avatarRef)).toEqual({ status: 'loading' })
      expect(loadAvatarUrl).toHaveBeenCalledWith(avatarRef)

      avatars.seed(avatarRef, seededUrl)
      expect(avatars.getSnapshot(avatarRef)).toEqual({ status: 'ready', url: seededUrl })
      expect(changed).toHaveBeenCalledTimes(1)

      oldRead.reject(new Error('late read failure'))
      await oldRead.promise.catch(() => undefined)
      await new Promise<void>(resolve => setTimeout(resolve, 0))

      expect(avatars.getSnapshot(avatarRef)).toEqual({ status: 'ready', url: seededUrl })
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      avatars.dispose()
    }
  })
})
