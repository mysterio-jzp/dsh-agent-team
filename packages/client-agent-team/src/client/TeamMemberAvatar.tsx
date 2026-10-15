import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentTeamClientMemberStatus } from '@contexera/dsh-agent-team/types'
import type { TeamSidebarProps } from './slots.ts'
import { presenceDotState, presenceLabel } from './TeamPresenceDot.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import { MemberAvatarSeat } from './MemberAvatarSeat.tsx'
import { useMemberAvatarUrl, type TeamMemberAvatars } from './member-avatars.ts'
import css from './sidebar.module.css'

/**
 * Sidebar Member avatar reusing the conversation identity language: the
 * deterministic member hue and handle initial, with the presence indicator
 * overlaid at the bottom-right so one glyph carries identity and state.
 *
 * The face itself comes from the shared seat, which is what keeps this one, the
 * roster's and the mention chip's the same picture of the same Member.
 */
export function TeamMemberAvatar({ status, t, avatarUrl, memberAvatars }: {
  readonly status: AgentTeamClientMemberStatus
  readonly t: TeamSidebarProps['t']
  /** Uploaded avatar for this Member, when the calling surface resolved one. */
  readonly avatarUrl?: string | undefined
  /** The shared Member face map; when present the seat resolves this Member's
   * own reference, so every roster line draws the picture without each caller
   * having to fetch it. */
  readonly memberAvatars?: TeamMemberAvatars | undefined
}) {
  const label = presenceLabel(status, t)
  const state = presenceDotState(status.presence)
  // A caller that already resolved bytes wins; otherwise the shared map answers
  // for the reference on this Member's own record.
  const resolved = useMemberAvatarUrl(memberAvatars, status.member.avatarRef)
  const face = avatarUrl ?? resolved
  return (
    <Tooltip label={label} delayMs={300}>
      <span className={css.agentAvatar}>
        <MemberAvatarSeat
          memberId={status.member.memberId}
          handle={status.member.handle}
          avatarUrl={face}
          size={24}
          label={label}
        />
        <span className={css.agentAvatarBadge} aria-hidden="true"><TeamStateDot state={state} /></span>
      </span>
    </Tooltip>
  )
}
