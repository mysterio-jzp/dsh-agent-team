import { useEffect, useRef, useState } from 'react'
import { Button, IconUserOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AgentTeamClientMemberStatus,
  AgentTeamMemberId,
  AgentTeamRemoveThreadMemberResult,
  AgentTeamThreadMember,
} from '@contexera/dsh-agent-team/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamConversationProps } from './slots.ts'
import { TeamMemberIdentity } from './TeamMemberRow.tsx'
import { candidateStatus, memberReachabilityStatus } from './thread-member-status.ts'
import css from './thread-members.module.css'

type Translate = TeamConversationProps['t']

export function TeamThreadMembers({
  members,
  threadMembers,
  removedMemberIds,
  channelMemberIds,
  activeClaimOwners,
  snapshotLoaded,
  snapshotLoading,
  snapshotError,
  refreshSnapshot,
  removeMember,
  addToDraft,
  focusComposer,
  memberAvatars,
  t,
}: {
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly threadMembers: readonly AgentTeamThreadMember[]
  readonly removedMemberIds: ReadonlySet<AgentTeamMemberId>
  readonly channelMemberIds: ReadonlySet<AgentTeamMemberId>
  readonly activeClaimOwners: ReadonlySet<AgentTeamMemberId>
  readonly snapshotLoaded: boolean
  readonly snapshotLoading: boolean
  readonly snapshotError?: string | undefined
  readonly refreshSnapshot: () => Promise<boolean>
  readonly removeMember: (memberId: AgentTeamMemberId) => Promise<RemoteResult<AgentTeamRemoveThreadMemberResult>>
  readonly addToDraft: (member: AgentTeamClientMemberStatus) => boolean
  readonly focusComposer: () => void
  readonly memberAvatars: TeamConversationProps['memberAvatars']
  readonly t: Translate
}) {
  const [open, setOpen] = useState(false)
  const [confirmingMemberId, setConfirmingMemberId] = useState<AgentTeamMemberId>()
  const [pendingMemberId, setPendingMemberId] = useState<AgentTeamMemberId>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [draftNotice, setDraftNotice] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const membersById = new Map(members.map(status => [status.member.memberId, status]))
  const snapshotReady = snapshotLoaded && snapshotError === undefined
  const currentMemberIds = new Set(threadMembers.map(member => member.memberId))
  const currentMembers = threadMembers.map(member => ({ member, status: membersById.get(member.memberId) }))
  const memberName = (memberId: AgentTeamMemberId): string => {
    const handle = membersById.get(memberId)?.member.handle
    return handle === undefined ? t('memberUnknown') : `@${handle.replace(/^@/, '')}`
  }
  const candidateMembers = members.filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived'
    && !currentMemberIds.has(status.member.memberId))
  const channelCandidates = candidateMembers.filter(status => channelMemberIds.has(status.member.memberId))
  const workspaceCandidates = candidateMembers.filter(status => !channelMemberIds.has(status.member.memberId))
  const confirmedMember = confirmingMemberId === undefined ? undefined : membersById.get(confirmingMemberId)
  const title = confirmingMemberId === undefined ? t('threadMembersTitle') : t('threadMemberRemoveTitle')

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => { contentRef.current?.focus({ preventScroll: true }) })
  }, [open, confirmingMemberId])

  const close = (): void => {
    if (pendingMemberId !== undefined) return
    setOpen(false)
    setConfirmingMemberId(undefined)
    setError(undefined)
    setNotice(undefined)
    requestAnimationFrame(() => {
      if (draftNotice) focusComposer()
      else triggerRef.current?.focus({ preventScroll: true })
      setDraftNotice(false)
    })
  }

  const openManager = (): void => {
    setOpen(true)
    setConfirmingMemberId(undefined)
    setPendingMemberId(undefined)
    setError(undefined)
    setNotice(undefined)
    setDraftNotice(false)
    void refreshSnapshot()
  }

  const confirmRemoval = async (memberId: AgentTeamMemberId): Promise<void> => {
    setPendingMemberId(memberId)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await removeMember(memberId)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      if (result.value.kind === 'blocked_by_active_claim') {
        setError(t('threadMemberActiveClaimBlocked'))
        return
      }
      if (result.value.kind === 'no_change') {
        const refreshed = await refreshSnapshot()
        setConfirmingMemberId(undefined)
        setNotice(refreshed ? t('threadMemberNoChange') : t('threadMemberRefreshFailed'))
        return
      }
      const refreshed = await refreshSnapshot()
      setConfirmingMemberId(undefined)
      setNotice(refreshed ? t('threadMemberRemovedSuccess', { member: memberName(memberId) }) : t('threadMemberRemovedRefreshFailed', { member: memberName(memberId) }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPendingMemberId(undefined)
    }
  }

  const renderCurrentMember = (member: AgentTeamThreadMember, status: AgentTeamClientMemberStatus | undefined) => {
    const memberId = member.memberId
    const activeClaim = activeClaimOwners.has(memberId)
    return <article className={css.row} key={memberId} data-thread-member={memberId}>
      {status === undefined
        ? <><span className={css.presencePlaceholder} aria-hidden="true" /><span className={css.missingIdentity}>{memberName(memberId)}</span></>
        : <TeamMemberIdentity status={status} t={t} memberAvatars={memberAvatars} className={css.identity} />}
      <div className={css.rowTail}>
        <span className={member.following ? css.reachable : css.unfollowed} data-thread-reachability={member.following ? 'following' : 'unfollowed'}>
          {memberReachabilityStatus(member.following, t)}
        </span>
        {activeClaim
          ? <span className={css.claimHint}>{t('threadMemberActiveClaimHint')}</span>
          : <Button size="sm" variant="outline" disabled={pendingMemberId !== undefined}
            onClick={() => { setError(undefined); setNotice(undefined); setConfirmingMemberId(memberId) }}>{t('threadMemberRemove')}</Button>}
      </div>
    </article>
  }

  const renderCandidate = (status: AgentTeamClientMemberStatus, source: 'channel' | 'workspace') => {
    const memberId = status.member.memberId
    const removed = removedMemberIds.has(memberId)
    const relation = candidateStatus(source, removed, t)
    return <article className={css.row} key={memberId} data-thread-candidate={memberId} data-removed={String(removed)}>
      <TeamMemberIdentity status={status} t={t} memberAvatars={memberAvatars} className={css.identity} />
      <div className={css.rowTail}>
        <span className={removed ? css.removed : css.candidate} data-thread-reachability={removed ? 'removed' : 'never-joined'}>
          {relation}
        </span>
        <Button size="sm" variant="outline" onClick={() => {
          const added = addToDraft(status)
          setDraftNotice(true)
          setNotice(t(added ? 'threadMemberDraftAdded' : 'threadMemberDraftAlreadyPresent', { member: memberName(memberId) }))
        }}>{t('threadMemberAddToDraft')}</Button>
      </div>
    </article>
  }

  return <>
    <button ref={triggerRef} type="button" className={css.trigger} aria-haspopup="dialog" aria-expanded={open} onClick={openManager}>
      <IconUserOutlineRegular size={15} aria-hidden="true" />
      <span aria-live="polite">{snapshotReady
        ? t('threadMembersCount', { count: threadMembers.length })
        : snapshotLoading || snapshotError === undefined
          ? t('threadMembersHeaderLoading')
          : t('threadMembersHeaderUnavailable')}</span>
      <span className={css.triggerAction}>{t('threadMembersManage')}</span>
    </button>
    <Modal open={open} onClose={close} title={title} closeLabel={t('close')} contentClassName={css.modal!} footer={confirmingMemberId === undefined
      ? <Button variant="outline" onClick={close}>{t('close')}</Button>
      : <>
        <Button variant="outline" disabled={pendingMemberId !== undefined} onClick={() => {
          setConfirmingMemberId(undefined)
          setError(undefined)
          setNotice(undefined)
        }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={pendingMemberId !== undefined} onClick={() => { void confirmRemoval(confirmingMemberId) }}>
          {pendingMemberId === confirmingMemberId ? t('threadMemberRemoving') : t('threadMemberConfirmRemove')}
        </Button>
      </>}>
      <div ref={contentRef} className={css.content} tabIndex={-1}>
        {confirmingMemberId !== undefined
          ? <section aria-labelledby="team-thread-member-confirm-title">
            <p id="team-thread-member-confirm-title" className={css.confirmCopy}>
              {t('threadMemberRemovePrompt', { member: confirmedMember === undefined ? `@${confirmingMemberId}` : memberName(confirmingMemberId) })}
            </p>
            <p className={css.scopeNotice}>{t('threadMemberRemovalScope')}</p>
            <p className={css.scopeNotice}>{t('threadMemberRemovalAccess')}</p>
            {error !== undefined && <p className={css.error} role="alert">{error}</p>}
            {notice !== undefined && <p className={css.notice} role="status">{notice}</p>}
          </section>
          : <>
            <p className={css.intro}>{t('threadMembersIntro')}</p>
            <p className={css.scopeNotice}>{t('threadMembersScope')}</p>
            {!snapshotReady && (snapshotLoading || snapshotError === undefined) && <p className={css.state} role="status">{t('threadMembersLoading')}</p>}
            {snapshotError !== undefined && !snapshotLoading && <div className={css.error} role="alert">
              <span>{snapshotError}</span>
              <Button size="sm" variant="outline" onClick={() => { void refreshSnapshot() }}>{t('retry')}</Button>
            </div>}
            {snapshotReady && <>
              <section className={css.group} aria-labelledby="team-thread-members-current">
                <div className={css.groupHeading}>
                  <h3 id="team-thread-members-current">{t('threadMembersCurrent')}</h3>
                  <span>{t('threadMembersReachableCount', { count: threadMembers.length })}</span>
                </div>
                {currentMembers.length === 0
                  ? <p className={css.empty}>{t('threadMembersEmpty')}</p>
                  : currentMembers.map(({ member, status }) => renderCurrentMember(member, status))}
              </section>
              <section className={css.group} aria-labelledby="team-thread-members-channel-candidates">
                <div className={css.groupHeading}>
                  <h3 id="team-thread-members-channel-candidates">{t('threadMembersChannelCandidates')}</h3>
                  <span>{t('threadMembersCandidateCount', { count: channelCandidates.length })}</span>
                </div>
                {channelCandidates.length === 0
                  ? <p className={css.empty}>{t('threadMembersNoCandidates')}</p>
                  : channelCandidates.map(status => renderCandidate(status, 'channel'))}
              </section>
              <section className={css.group} aria-labelledby="team-thread-members-workspace-candidates">
                <div className={css.groupHeading}>
                  <h3 id="team-thread-members-workspace-candidates">{t('threadMembersWorkspaceCandidates')}</h3>
                  <span>{t('threadMembersCandidateCount', { count: workspaceCandidates.length })}</span>
                </div>
                {workspaceCandidates.length === 0
                  ? <p className={css.empty}>{t('threadMembersNoCandidates')}</p>
                  : workspaceCandidates.map(status => renderCandidate(status, 'workspace'))}
              </section>
            </>}
            {notice !== undefined && <p className={css.notice} role="status">{notice}</p>}
          </>}
      </div>
    </Modal>
  </>
}

