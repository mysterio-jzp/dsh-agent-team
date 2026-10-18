import type { TeamDraftKey } from './drafts.ts'
import type { MentionTier } from './TeamComposer.tsx'

/**
 * Which surface the composer is writing into. A tier means something different
 * on each — tier 1 takes part in the Channel conversation yet not in a given
 * Thread's — so the weight cannot be derived from the tier alone.
 */
export type MentionSurface = 'thread' | 'channel'

/**
 * The surface a composer is on, read from the draft key it already writes to:
 * that key's discriminant names the conversation the draft belongs to, so a
 * second prop could only restate — or contradict — it.
 */
export function mentionSurfaceOf(draftKey: TeamDraftKey): MentionSurface {
  return draftKey.startsWith('thread:') ? 'thread' : 'channel'
}

/**
 * Whether a tier already takes part in the conversation being written into.
 * On a Thread, both following and unfollowed members are inside; the explicit
 * membership fact is separate from the rank that puts followers first. A
 * Channel send counts every Channel participant because the Channel is the
 * conversation there.
 */
export function mentionTierIsParticipant(tier: MentionTier, surface: MentionSurface, threadMember = false): boolean {
  return surface === 'thread' ? tier === 0 || threadMember : tier !== 2
}
