import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamClientMemberStatus,
  AgentTeamModelSelection,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconArchiveOutlineRegular, IconEditOutlineRegular, IconPlayOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, Input, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamSidebarProps } from './slots.ts'
import { TeamMemberIdentity } from './TeamMemberRow.tsx'
import { SortableRow, useSidebarRowDrag } from './sidebar-drag.tsx'
import { moveSidebarItem, useSidebarOrder } from './sidebar-order.ts'
import { useSidebarSectionOpen, setSidebarSectionOpen } from './sidebar-sections.ts'
import { mintRequestId } from './requests.ts'
import { channelRowActivity, diagnosticText, restartOffered } from './TeamPresenceDot.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import { formatChannelRowReason } from './team-formatters.ts'
import { TeamRowMenu } from './TeamRowMenu.tsx'
import { TeamSidebarSection } from './TeamSidebarSection.tsx'
import { AgentEditorDialog, ModelPickerField, sameModel, warmModelCatalog } from './TeamMemberEditor.tsx'
import { TeamAgentImport } from './TeamAgentImport.tsx'
import createCss from './create.module.css'
import css from './sidebar.module.css'

interface TeamAgentsPanelProps {
  readonly workspaceId: WorkspaceId
  readonly loadMembers: TeamSidebarProps['loadMembers']
  readonly subscribeChanges: TeamSidebarProps['subscribeChanges']
  readonly addMember: TeamSidebarProps['addMember']
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly setPresident: TeamSidebarProps['setPresident']
  readonly recoverMember: TeamSidebarProps['recoverMember']
  readonly archiveMember: TeamSidebarProps['archiveMember']
  readonly joinWorkspace: TeamSidebarProps['joinWorkspace']
  readonly leaveWorkspace: TeamSidebarProps['leaveWorkspace']
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly putMemberAvatar: TeamSidebarProps['putMemberAvatar']
  readonly removeMemberAvatar: TeamSidebarProps['removeMemberAvatar']
  readonly memberAvatars: TeamSidebarProps['memberAvatars']
  readonly openMemberPersonaPath: TeamSidebarProps['openMemberPersonaPath']
  /** The Member Session currently embedded in the conversation seat, if any. */
  readonly memberSessionId?: AgentTeamClientMemberStatus['member']['sessionId']
  readonly openMemberSession: TeamSidebarProps['openMemberSession']
  readonly onCreatingChange: (request: AgentTeamAddMemberRequest, creating: boolean) => void
  readonly t: TeamSidebarProps['t']
}

export function TeamAgentsPanel({ workspaceId, loadMembers, subscribeChanges, addMember, updateMember, setPresident, recoverMember, archiveMember, joinWorkspace, leaveWorkspace, loadModels, putMemberAvatar, removeMemberAvatar, memberAvatars, openMemberPersonaPath, memberSessionId, openMemberSession, onCreatingChange, t }: TeamAgentsPanelProps) {
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [formOpen, setFormOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [handle, setHandle] = useState('')
  const [description, setDescription] = useState('')
  const [model, setModel] = useState<AgentTeamModelSelection | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [retryRequest, setRetryRequest] = useState<AgentTeamAddMemberRequest>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Same presentation-preference ordering as the Channels list; the drag
  // commits through one shared mutation.
  const agentRefs = useMemo(() => members.map(status => status.member.memberId), [members])
  const orderedAgentRefs = useSidebarOrder(workspaceId, 'agents', agentRefs)
  const orderedMembers = useMemo(() => {
    const byId = new Map(members.map(status => [status.member.memberId, status]))
    return orderedAgentRefs.map(memberId => byId.get(memberId)).filter(status => status !== undefined)
  }, [orderedAgentRefs, members])
  const applyMove = (movedRef: typeof agentRefs[number], targetRef: typeof agentRefs[number], marker: 'before' | 'after'): void => {
    void moveSidebarItem(workspaceId, 'agents', orderedAgentRefs, movedRef, targetRef, marker)
  }
  const drag = useSidebarRowDrag({ refs: orderedAgentRefs, onCommit: applyMove })
  const sectionOpen = useSidebarSectionOpen(workspaceId, 'agents')

  // Observe each Member/Channel binding while mounted. A Channel rollover
  // follows only the exact previous live Session shown by the seat, and only
  // once the replacement Channel row is ready; navigating away during the
  // commit window cancels the follow instead of reopening an unrelated Session.
  const observedChannelSessions = useRef(new Map<string, AgentTeamClientMemberStatus['channels'][number]['sessionId']>())
  const pendingFollows = useRef(new Map<string, { readonly previousSessionId: NonNullable<AgentTeamClientMemberStatus['channels'][number]['sessionId']>; readonly nextSessionId?: AgentTeamClientMemberStatus['channels'][number]['sessionId'] }>())
  // Read the live seat value: a workspace invalidation may run through a
  // refresh closure captured before navigation changed.
  const seatSessionIdRef = useRef(memberSessionId)
  seatSessionIdRef.current = memberSessionId
  const openMemberSessionRef = useRef(openMemberSession)
  openMemberSessionRef.current = openMemberSession
  const followRollover = useCallback((statuses: readonly AgentTeamClientMemberStatus[]) => {
    const presentChannels = new Set<string>()
    for (const status of statuses) {
      for (const row of status.channels ?? []) {
        const key = `${status.member.memberId}\u0000${row.channelRef}`
        presentChannels.add(key)
        const hadObservation = observedChannelSessions.current.has(key)
        const observed = observedChannelSessions.current.get(key)
        if (!hadObservation) {
          observedChannelSessions.current.set(key, row.sessionId)
          continue
        }
        if (observed !== row.sessionId) {
          observedChannelSessions.current.set(key, row.sessionId)
          const seatSessionId = seatSessionIdRef.current
          const pending = pendingFollows.current.get(key)
          if (observed !== undefined && seatSessionId === observed) {
            pendingFollows.current.set(key, { previousSessionId: observed, nextSessionId: row.sessionId })
          } else if (pending !== undefined && seatSessionId === pending.previousSessionId) {
            pendingFollows.current.set(key, { ...pending, nextSessionId: row.sessionId })
          } else {
            pendingFollows.current.delete(key)
          }
        }
        const pending = pendingFollows.current.get(key)
        if (pending?.nextSessionId !== undefined && pending.nextSessionId === row.sessionId && row.state === 'ready') {
          const seatSessionId = seatSessionIdRef.current
          pendingFollows.current.delete(key)
          if (seatSessionId === pending.previousSessionId) openMemberSessionRef.current(pending.nextSessionId)
        }
      }
    }
    for (const key of observedChannelSessions.current.keys()) {
      if (!presentChannels.has(key)) {
        observedChannelSessions.current.delete(key)
        pendingFollows.current.delete(key)
      }
    }
  }, [])

  // Only the first refresh owns the loading surface; presence wakes (Agent
  // running/idle) ride the dedicated scope and refresh rows in place.
  const loadedRef = useRef(false)
  const mountedRef = useRef(false)
  const refresh = useCallback(async () => {
    if (!loadedRef.current) setLoading(true)
    const result = await loadMembers({ workspaceId })
    // A response for a panel the user has already left changes nothing: the
    // key-remounted successor owns the roster state — and the seat-follow
    // side effects — now.
    if (!mountedRef.current) return
    if (result.ok) {
      // Archived Members are hidden from every surface; the row disappears
      // the moment the workspace-scope wake delivers the archived state.
      const next = result.value.filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived')
      setMembers(next)
      followRollover(next)
      setError(undefined)
      loadedRef.current = true
    } else {
      setError(result.error.message)
    }
    setLoading(false)
  }, [loadMembers, workspaceId, followRollover])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  // Warm the Host model catalog while the roster loads, so the create and
  // edit pickers open with rows instead of paying the first read on open.
  // Mount-scoped (not per refresh): presence wakes must not refetch it.
  useEffect(() => { warmModelCatalog(loadModels) }, [loadModels])
  useEffect(() => subscribeChanges({ kind: 'workspace', workspaceId }, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    // The section stays mounted across Channel creation, so the Member roster
    // rides every workspace invalidation.
    void refresh()
  }), [subscribeChanges, refresh, workspaceId])
  // Presence transitions commit nothing: the Host wakes only this scope, so
  // the green dots stay live without any catalog refetch.
  useEffect(() => subscribeChanges({ kind: 'presence', workspaceId }, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    void refresh()
  }), [subscribeChanges, refresh, workspaceId])

  const closeForm = () => {
    if (creating) return
    setFormOpen(false)
    queueMicrotask(() => { triggerRef.current?.focus({ preventScroll: true }) })
  }

  const provision = async (request: AgentTeamAddMemberRequest) => {
    setCreating(true)
    onCreatingChange(request, true)
    setError(undefined)
    setRetryRequest(request)
    try {
      const result = await addMember(request)
      if (result.ok) {
        // A just-created Member holds no Channel yet, so the row set is known
        // rather than fetched: the add request grants none, and the next change
        // notification replaces this projection with the Host's own.
        const committed = { ...result.value.status, workspaceIds: result.value.workspaceIds, channels: [] as const }
        setMembers(current => {
          const retained = current.filter(status => status.member.memberId !== committed.member.memberId)
          return committed.member.state === 'inactive' || committed.member.state === 'archived' ? retained : [...retained, committed]
        })
        setHandle('')
        setDescription('')
        setModel(undefined)
        setFormOpen(false)
        if (result.value.status.presence === 'unavailable') {
          setError(diagnosticText(result.value.status) || t('statusUnavailable'))
        } else {
          setRetryRequest(undefined)
        }
        queueMicrotask(() => { triggerRef.current?.focus({ preventScroll: true }) })
      } else {
        await refresh()
        setError(result.error.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
      onCreatingChange(request, false)
    }
  }

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedHandle = handle.trim()
    const normalizedDescription = description.trim()
    if (normalizedHandle.length === 0 || creating) return
    const sameRequest = retryRequest !== undefined && retryRequest.workspaceId === workspaceId
      && retryRequest.handle === normalizedHandle && retryRequest.description === normalizedDescription
      && sameModel(retryRequest.model, model)
      && retryRequest.channelRefs.length === 0
    void provision(sameRequest ? retryRequest : {
      requestId: mintRequestId(),
      workspaceId,
      handle: normalizedHandle,
      description: normalizedDescription,
      presetId: 'team-member',
      // No initial Channels at creation: the Member joins Channels later from
      // the Channel side and stays reachable through its DM view meanwhile.
      channelRefs: [],
      ...(model === undefined ? {} : { model }),
    })
  }

  return (
    <div className={css.panel}>
      <Modal
        open={formOpen}
        onClose={closeForm}
        title={t('addAgent')}
        closeLabel={t('close')}
        contentClassName={createCss.dialogContent!}
        footer={<><Button variant="outline" disabled={creating} onClick={closeForm}>{t('cancel')}</Button>{!importing && <Button type="submit" form="team-agent-create-form" variant="primary" disabled={creating || handle.trim().length === 0}>{creating ? t('creatingAgent') : t('createAgent')}</Button>}</>}
      >
        <Button className={createCss.modeSwitch!} variant="outline" disabled={creating} aria-expanded={importing} onClick={() => { setImporting(value => !value); setError(undefined) }}>{importing ? t('createAgent') : t('importAgentTitle')}</Button>
        {formOpen && importing ? <TeamAgentImport workspaceId={workspaceId} loadMembers={loadMembers} joinWorkspace={joinWorkspace} onPending={setCreating} onJoined={async () => { await refresh(); setFormOpen(false); queueMicrotask(() => { triggerRef.current?.focus({ preventScroll: true }) }) }} t={t} /> : <form id="team-agent-create-form" className={createCss.form} onSubmit={submit}>
          <label className={createCss.field}>
            <span>{t('agentName')}</span>
            <Input className={createCss.input!} value={handle} onChange={event => { setHandle(event.target.value); setRetryRequest(undefined) }} disabled={creating} autoFocus />
          </label>
          <label className={createCss.field}>
            <span>{t('agentDescription')}{t('optionalSuffix')}</span>
            <Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} onChange={event => { setDescription(event.target.value); setRetryRequest(undefined) }} disabled={creating} />
          </label>
          <ModelPickerField model={model} onModelChange={choice => { setModel(choice); setRetryRequest(undefined) }} loadModels={loadModels} disabled={creating} t={t} />
          {formOpen && error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
        </form>}
      </Modal>
      <TeamSidebarSection
        title={t('agents')}
        open={sectionOpen}
        onToggle={open => { setSidebarSectionOpen(workspaceId, 'agents', open) }}
        actions={(
          <Tooltip label={t('addAgent')} delayMs={500}>
            <button ref={triggerRef} type="button" className={css.iconButton} aria-label={t('addAgent')} onClick={() => { setError(undefined); setImporting(false); setFormOpen(true) }}>
              <IconPlusOutlineRegular size={14} />
            </button>
          </Tooltip>
        )}
      >
        {loading && members.length === 0 && <p className={css.emptyState}>{t('loadingAgents')}</p>}
        {/* `members` is empty both before the first successful load and after a
            failed one, so the empty claim additionally requires a clear error. */}
        {!loading && error === undefined && members.length === 0 && <p className={css.emptyState}>{t('emptyAgents')}</p>}
        <div className={css.agentList}>
          {orderedMembers.map(status => (
            <SortableRow key={status.member.memberId} drag={drag} orderKey={status.member.memberId}>
              <AgentRow workspaceId={workspaceId} leaveWorkspace={leaveWorkspace} status={status} updateMember={updateMember} setPresident={setPresident} recoverMember={recoverMember} archiveMember={archiveMember} loadModels={loadModels} putMemberAvatar={putMemberAvatar} removeMemberAvatar={removeMemberAvatar} memberAvatars={memberAvatars} openMemberPersonaPath={openMemberPersonaPath} openMemberSession={openMemberSession} onUpdated={refresh} t={t} />
            </SortableRow>
          ))}
        </div>
      </TeamSidebarSection>
      {!formOpen && error !== undefined && (
        <div className={css.retryError} role="alert">
          <span>{error}</span>
          {retryRequest !== undefined && <button type="button" className={css.textButton} disabled={creating} onClick={() => { setFormOpen(true) }}>{t('retry')}</button>}
        </div>
      )}
    </div>
  )
}

/**
 * The Channel layer of one Member's session tree: a row per Channel the Member
 * belongs to, each naming its state and — when it cannot be opened — the
 * sentence explaining why.
 *
 * A row is a button only while it has a Session and no failure, so the tree
 * never offers a click that goes nowhere. The reason lives in the row's own
 * text rather than a title or tooltip: it has to be readable without hovering,
 * and a tooltip is invisible to a touch screen, a keyboard-only reader, and
 * anyone scanning the list.
 */
function ChannelRows({ status, openMemberSession, setRowAlert, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly openMemberSession: TeamSidebarProps['openMemberSession']
  readonly setRowAlert: (message: string) => void
  readonly t: TeamSidebarProps['t']
}) {
  return (
    <ul className={css.channelRows} aria-label={t('channelRowsLabel', { name: status.member.handle.replace(/^@/, '') })}>
      {status.channels.map(row => {
        const reason = formatChannelRowReason(row, t)
        const openable = row.state === 'ready' && row.sessionId !== undefined
        const activity = channelRowActivity(row)
        const body = (
          <>
            <span className={css.channelRowStatus} data-channel-row-status={activity} aria-hidden="true">
              {activity === 'warning'
                ? (
                  <svg
                    className={css.channelRowWarningIcon}
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M8 2.5 14.6 13.6H1.4z" />
                    <path d="M8 6.6v3.2" />
                    <path d="M8 11.9h.01" />
                  </svg>
                )
                : <TeamStateDot state={activity === 'running' ? 'ongoing' : 'done'} size={activity === 'running' ? 12 : 10} />}
            </span>
            <span className={css.channelRowName}>{row.channelName}</span>
          </>
        )
        return (
          <li key={row.channelRef} className={css.channelRow} data-channel-row data-channel-row-ok={openable || undefined}>
            {openable
              ? <button type="button" className={css.channelRowSelect} onClick={() => { openMemberSession(row.sessionId!, message => { setRowAlert(t('openAgentSessionFailed', { name: row.channelName, message })) }) }}>{body}</button>
              : <div className={css.channelRowSelect} aria-disabled="true">{body}</div>}
            {/* Always rendered when there is a reason, never clamped or hidden:
                an unopenable row with no visible reason is the failure this
                layer exists to prevent. */}
            {reason !== undefined && <p className={css.channelRowReason}>{reason}</p>}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * One sidebar Agent row: its control expands the Channel list when the Member
 * has Channels. An Agent identity without Channels is not a Session entry
 * point; its row menu still opens the editor and other management actions.
 */
function AgentRow({ workspaceId, leaveWorkspace, status, updateMember, setPresident, recoverMember, archiveMember, loadModels, putMemberAvatar, removeMemberAvatar, memberAvatars, openMemberPersonaPath, openMemberSession, onUpdated, t }: {
  readonly workspaceId: WorkspaceId
  readonly leaveWorkspace: TeamSidebarProps['leaveWorkspace']
  readonly status: AgentTeamClientMemberStatus
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly setPresident: TeamSidebarProps['setPresident']
  readonly recoverMember: TeamSidebarProps['recoverMember']
  readonly archiveMember: TeamSidebarProps['archiveMember']
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly putMemberAvatar: TeamSidebarProps['putMemberAvatar']
  readonly removeMemberAvatar: TeamSidebarProps['removeMemberAvatar']
  readonly memberAvatars: TeamSidebarProps['memberAvatars']
  readonly openMemberPersonaPath: TeamSidebarProps['openMemberPersonaPath']
  readonly openMemberSession: TeamSidebarProps['openMemberSession']
  readonly onUpdated: () => Promise<void> | void
  readonly t: TeamSidebarProps['t']
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [channelsOpen, setChannelsOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [rowAlert, setRowAlert] = useState<string>()
  const [archivePending, setArchivePending] = useState(false)
  const archiveRequest = useRef<ReturnType<typeof mintRequestId>>()
  const withdrawing = workspaceId !== status.member.workspaceId
  const hasChannels = (status.channels?.length ?? 0) > 0
  // Both row actions ride the same runtime remote: the Host steers a live
  // session, rebuilds an orphaned composition, or re-runs a failed activation.
  const recover = async (): Promise<void> => {
    try {
      const result = await recoverMember({
        requestId: mintRequestId(),
        workspaceId: status.member.workspaceId,
        memberId: status.member.memberId,
      })
      await onUpdated()
      if (!result.ok) {
        setRowAlert(t('restartFailed', { message: result.error.message }))
        return
      }
      if (result.value.status.availability === 'unavailable') {
        setRowAlert(t('restartStillUnavailable', { diagnostic: diagnosticText(result.value.status) || t('statusUnavailable') }))
        return
      }
      setRowAlert(undefined)
    } catch (cause) {
      setRowAlert(t('restartFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }
  const archive = async (): Promise<void> => {
    if (archivePending) return
    setArchivePending(true)
    setRowAlert(undefined)
    archiveRequest.current ??= mintRequestId()
    const request = { requestId: archiveRequest.current, memberId: status.member.memberId }
    try {
      const result = withdrawing ? await leaveWorkspace({ ...request, workspaceId }) : await archiveMember(request)
      if (!result.ok) throw new Error(result.error.message)
      setArchiving(false)
      archiveRequest.current = undefined
      await onUpdated()
    } catch (cause) {
      setRowAlert(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setArchivePending(false)
    }
  }
  return (
    <>
      <div className={css.agentRow} data-agent-row data-menu-open={menuOpen || undefined}>
        <button type="button" className={css.agentSelect} {...(hasChannels ? { 'aria-label': t('toggleAgentChannels', { name: status.member.handle }), 'aria-expanded': channelsOpen } : {})} disabled={!hasChannels} onClick={() => { if (hasChannels) setChannelsOpen(open => !open) }}>
          <TeamMemberIdentity status={status} name={status.member.handle.replace(/^@/, '')} className={css.agentCopy} t={t} memberAvatars={memberAvatars} />
        </button>
        {status.member.president === true && <span className={css.presidentBadge} title={t('presidentManagerBadgeHint')}>{t('presidentRole')}</span>}
        <span className={css.rowMenu}>
          <TeamRowMenu
            label={t('actionsAgent', { name: status.member.handle })}
            items={[
              { id: 'edit', label: t('editAgent'), icon: <IconEditOutlineRegular /> },
              ...(status.presence === 'error' ? [{ id: 'resume', label: t('resumeAgent'), icon: <IconPlayOutlineRegular /> }] : []),
              ...(status.availability === 'unavailable' && restartOffered(status) ? [{ id: 'restart', label: t('restartAgent'), icon: <IconRefreshOutlineRegular /> }] : []),
              { id: 'archive', label: t(withdrawing ? 'withdrawAgent' : 'archiveAgent'), icon: <IconArchiveOutlineRegular size={16} />, danger: true },
            ]}
            onSelect={(id) => {
              if (id === 'edit') setEditing(true)
              else if (id === 'archive') setArchiving(true)
              else void recover()
            }}
            onOpenChange={setMenuOpen}
          />
        </span>
      </div>
      {/* `channels` is read defensively: a Client can meet a Host older than the
          row projection and must render the Agent line without the Channel
          layer rather than crash the whole sidebar slot. */}
      {hasChannels && channelsOpen && <ChannelRows status={status} openMemberSession={openMemberSession} setRowAlert={setRowAlert} t={t} />}
      {!archiving && rowAlert !== undefined && <div className={css.rowAlert} role="alert">{rowAlert}</div>}
      {archiving && (
        <Modal
          open
          onClose={() => { if (!archivePending) setArchiving(false) }}
          title={t(withdrawing ? 'withdrawAgentTitle' : 'archiveAgentTitle', { name: status.member.handle })}
          closeLabel={t('close')}
          contentClassName={createCss.dialogContent!}
          footer={<>
            <Button variant="outline" disabled={archivePending} onClick={() => { setArchiving(false) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={archivePending} onClick={() => { void archive() }}>{t(withdrawing ? 'withdrawAgent' : 'archiveAgentConfirm')}</Button>
          </>}
        >
          <p className={createCss.error}>{t(withdrawing ? 'withdrawAgentNotice' : 'archiveAgentNotice', { name: status.member.handle })}</p>
          {!withdrawing && status.workspaceIds.length > 1 && <p>{t('archiveOtherWorkspaces', { count: status.workspaceIds.length - 1 })}</p>}
          {rowAlert !== undefined && <p className={createCss.error} role="alert">{rowAlert}</p>}
        </Modal>
      )}
      {editing && (
        <AgentEditorDialog
          status={status}
          updateMember={updateMember}
          setPresident={setPresident}
          loadModels={loadModels}
          openMemberPersonaPath={openMemberPersonaPath}
          putMemberAvatar={putMemberAvatar}
          removeMemberAvatar={removeMemberAvatar}
          memberAvatars={memberAvatars}
          onCommitted={onUpdated}
          onClose={() => { setEditing(false) }}
          t={t}
        />
      )}
    </>
  )
}
