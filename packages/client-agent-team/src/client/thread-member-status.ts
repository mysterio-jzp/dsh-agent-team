import type { AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import type { TeamConversationProps } from './slots.ts'

export type ThreadMentionState = 'following' | 'unfollowed' | 'removed' | 'channel-candidate' | 'workspace-candidate'

type Translate = TeamConversationProps['t']

export function threadMentionState(memberId: AgentTeamMemberId, threadMemberIds: ReadonlySet<AgentTeamMemberId> | undefined,
  followerIds: ReadonlySet<AgentTeamMemberId> | undefined, removedMemberIds: ReadonlySet<AgentTeamMemberId> | undefined,
  channelMemberIds: ReadonlySet<AgentTeamMemberId> | undefined): ThreadMentionState {
  if (threadMemberIds?.has(memberId) === true) return followerIds?.has(memberId) === true ? 'following' : 'unfollowed'
  if (removedMemberIds?.has(memberId) === true) return 'removed'
  if (channelMemberIds?.has(memberId) === true) return 'channel-candidate'
  return 'workspace-candidate'
}

export function threadMentionStateLabel(state: ThreadMentionState, t: Translate): string {
  switch (state) {
    case 'following': return t('threadMentionFollowing')
    case 'unfollowed': return t('threadMentionUnfollowed')
    case 'removed': return t('threadMentionRemoved')
    case 'channel-candidate': return t('threadMentionChannelCandidate')
    case 'workspace-candidate': return t('threadMentionWorkspaceCandidate')
  }
}

export function memberReachabilityStatus(following: boolean, t: Translate): string {
  return t(following ? 'threadMemberFollowingReachable' : 'threadMemberUnfollowedReachable')
}

export function candidateStatus(source: 'channel' | 'workspace', removed: boolean, t: Translate): string {
  if (removed) return t('threadMentionRemoved')
  return t(source === 'channel' ? 'threadMentionChannelCandidate' : 'threadMentionWorkspaceCandidate')
}
