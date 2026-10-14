import { useEffect, useRef, useState } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamModelSelection, AgentTeamUpdateMemberRequest } from '@contexera/dsh-agent-team/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamModelCatalog, TeamModelEffortOption, TeamModelProviderGroup, TeamSidebarProps } from './slots.ts'
import { Button, IconChevronDownOutlineRegular, Input, Menu, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { mintRequestId } from './requests.ts'
import { useMemberAvatarUrl } from './member-avatars.ts'
import { useAvatarImage } from './avatar-image.ts'
import { MemberAvatarSeat } from './MemberAvatarSeat.tsx'
import { bytesToBase64 } from './attachment-preview.ts'
import { useEditDialogSave } from './team-dialog-save.ts'
import createCss from './create.module.css'
import css from './sidebar.module.css'

/**
 * Largest avatar the editor will hand the Host. The Human's own settings page
 * uses the same ceiling, so one picture is accepted in both places.
 */
const AVATAR_MAX_BYTES = 10 * 1024 * 1024

/** Model option key inside one editor; opaque and resolved against the loaded groups. */
function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * Shared Host catalog across the pickers: one in-flight read while pending,
 * last good value afterwards. Revalidation re-reads (a slow Host still
 * refreshes behind already-rendered rows), and a loader that starts throwing
 * keeps serving its last good value rather than blanking every picker.
 */
interface ModelCatalogCache {
  inflight?: Promise<RemoteResult<TeamModelCatalog>>
  value?: TeamModelCatalog
}

const modelCatalogCaches = new WeakMap<TeamSidebarProps['loadModels'], ModelCatalogCache>()

function peekCatalogGroups(loadModels: TeamSidebarProps['loadModels']): readonly TeamModelProviderGroup[] | undefined {
  return modelCatalogCaches.get(loadModels)?.value?.groups
}

function sharedCatalog(loadModels: TeamSidebarProps['loadModels']): Promise<RemoteResult<TeamModelCatalog>> {
  const cached = modelCatalogCaches.get(loadModels)
  if (cached?.inflight !== undefined) return cached.inflight
  const next = loadModels()
  const entry = cached ?? {}
  entry.inflight = next
  modelCatalogCaches.set(loadModels, entry)
  const forget = (result: RemoteResult<TeamModelCatalog> | undefined): void => {
    if (modelCatalogCaches.get(loadModels) === entry && entry.inflight === next) {
      delete entry.inflight
      if (result !== undefined && result.ok) entry.value = result.value
    }
  }
  next.then(
    (result) => { forget(result) },
    () => { forget(undefined) },
  )
  return next
}

/**
 * Best-effort warm of the shared catalog (the agents panel calls this while
 * the roster loads, so the pickers open with rows instead of paying the
 * first read on open). Failures belong to the picker's own error surface.
 */
export function warmModelCatalog(loadModels: TeamSidebarProps['loadModels']): void {
  try {
    void sharedCatalog(loadModels).catch(() => {
      // The picker that later reads surfaces the failure with its retry entry.
    })
  } catch {
    // Same: a synchronously refused warm leaves no trace; the picker reports it.
  }
}

/**
 * Shared provider/model dropdown for the create and edit forms. The option
 * list rides the shared Menu primitive (one leading "follow Host default"
 * row, then non-selectable provider headings) with a capped, internally
 * scrolling card so growing model catalogs cannot stretch the dialog. Mounts
 * open with the warmed value when one exists and revalidate behind it, so a
 * slow Host read delays a refresh — never the picker itself; a refused or
 * failed read with no warmed value renders a retryable error instead of
 * stranding the field on "loading".
 */
export function ModelPickerField({ model, onModelChange, loadModels, disabled, t }: {
  readonly model: AgentTeamModelSelection | undefined
  readonly onModelChange: (choice: AgentTeamModelSelection | undefined) => void
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly disabled: boolean
  readonly t: TeamSidebarProps['t']
}) {
  const [groups, setGroups] = useState<readonly TeamModelProviderGroup[] | undefined>(() => peekCatalogGroups(loadModels))
  const [modelsError, setModelsError] = useState<string>()
  const [reloadToken, setReloadToken] = useState(0)
  const [open, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  useEffect(() => {
    let mounted = true
    let pending: Promise<RemoteResult<TeamModelCatalog>>
    try {
      pending = sharedCatalog(loadModels)
    } catch (error) {
      // A synchronously refused read (an undeclared remote, a dead scope)
      // used to strand the field on "loading" forever with no diagnostic;
      // surface it as the same retryable failure an answered refusal gets.
      // Last good rows stay rendered underneath, matching a refused answer.
      setModelsError(error instanceof Error ? error.message : String(error))
      return
    }
    void pending.then(
      (result) => {
        if (!mounted) return
        if (result.ok) {
          setGroups(result.value.groups)
          setModelsError(undefined)
        } else {
          setModelsError(result.error.message)
        }
      },
      (error: unknown) => {
        // A rejected read (a transport that died mid-call) previously fell
        // through as an unhandled rejection behind the same endless loading
        // line; it retries like any other failure.
        if (!mounted) return
        setModelsError(error instanceof Error ? error.message : String(error))
      },
    )
    return () => { mounted = false }
  }, [loadModels, reloadToken])

  const items: MenuEntry[] = [{ id: '', label: t('modelFollowDefault') }]
  const byKey = new Map<string, { provider: string; id: string; name: string; efforts: readonly TeamModelEffortOption[] }>()
  for (const group of groups ?? []) {
    items.push({ type: 'label', id: `model-group:${group.id}`, text: group.name })
    for (const entry of group.models) {
      const key = modelKey(group.id, entry.id)
      byKey.set(key, { provider: group.id, id: entry.id, name: entry.name, efforts: entry.reasoning?.efforts ?? [] })
      items.push({ id: key, label: entry.name })
    }
  }
  const selectedModelKey = model === undefined ? '' : modelKey(model.provider, model.model)
  const triggerLabel = model === undefined
    ? t('modelFollowDefault')
    : byKey.get(selectedModelKey)?.name ?? `${model.provider} / ${model.model}`
  // The effort sub-row only makes sense for a pinned model with adapter-exposed
  // efforts; following the Host default inherits the operator's whole selection.
  const efforts = model === undefined ? [] : byKey.get(selectedModelKey)?.efforts ?? []
  const effortItems: MenuEntry[] = [{ id: '', label: t('effortFollowDefault') }, ...efforts.map(effort => ({ id: effort.id, label: effort.name }))]
  const selectedEffort = model?.reasoningEffort ?? ''
  const effortTriggerLabel = model === undefined || selectedEffort === ''
    ? t('effortFollowDefault')
    : efforts.find(effort => effort.id === selectedEffort)?.name ?? selectedEffort

  return <div className={createCss.field}>
    <span>{t('memberModel')}</span>
    {groups === undefined && modelsError === undefined && <small className={css.editHint}>{t('modelsLoading')}</small>}
    {modelsError !== undefined && (
      <p className={css.editHint}>
        <span role="alert">{t('modelsLoadFailed', { message: modelsError })}</span>
        {' '}
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => { setModelsError(undefined); setReloadToken(token => token + 1) }}
        >
          {t('retry')}
        </Button>
      </p>
    )}
    {groups !== undefined && (
      <Menu
        open={open}
        portal
        className={createCss.menuCap!}
        items={items}
        selectedId={selectedModelKey}
        onSelect={key => {
          setModelOpen(false)
          const choice = byKey.get(key)
          onModelChange(choice === undefined ? undefined : { provider: choice.provider, model: choice.id })
        }}
        onClose={() => { setModelOpen(false) }}
        anchor={
          <button
            type="button"
            className={createCss.selectTrigger!}
            aria-label={t('memberModel')}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => { setModelOpen(value => !value) }}
          >
            <span className={createCss.selectValue}>{triggerLabel}</span>
            <span className={`${createCss.chevron!} ${open ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
          </button>
        }
      />
    )}
    {model !== undefined && efforts.length > 0 && (
      <Menu
        open={effortOpen}
        portal
        className={createCss.menuCap!}
        items={effortItems}
        selectedId={selectedEffort}
        onSelect={key => {
          setEffortOpen(false)
          onModelChange(key === ''
            ? { provider: model.provider, model: model.model }
            : { provider: model.provider, model: model.model, reasoningEffort: key as NonNullable<AgentTeamModelSelection['reasoningEffort']> })
        }}
        onClose={() => { setEffortOpen(false) }}
        anchor={
          <button
            type="button"
            className={createCss.selectTrigger!}
            aria-label={t('reasoningEffort')}
            aria-haspopup="menu"
            aria-expanded={effortOpen}
            disabled={disabled}
            onClick={() => { setEffortOpen(value => !value) }}
          >
            <span className={createCss.selectValue}>{`${t('reasoningEffort')} · ${effortTriggerLabel}`}</span>
            <span className={`${createCss.chevron!} ${effortOpen ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
          </button>
        }
      />
    )}
  </div>
}

/**
 * Agent editor: handle, description, and per-Member model selection commit
 * through one durable update. Channel membership is managed from the Channel
 * side, not here.
 */
export function AgentEditorDialog({ status, updateMember, loadModels, putMemberAvatar, removeMemberAvatar, memberAvatars, openMemberPersonaPath, onCommitted, onClose, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly putMemberAvatar: TeamSidebarProps['putMemberAvatar']
  readonly removeMemberAvatar: TeamSidebarProps['removeMemberAvatar']
  readonly memberAvatars: TeamSidebarProps['memberAvatars']
  readonly openMemberPersonaPath: TeamSidebarProps['openMemberPersonaPath']
  readonly onCommitted: () => Promise<void> | void
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const memberId = status.member.memberId
  const [handle, setHandle] = useState(status.member.handle)
  const [description, setDescription] = useState(status.member.description)
  const [model, setModel] = useState<AgentTeamModelSelection | undefined>(status.member.model)
  const [avatarRef, setAvatarRef] = useState(status.member.avatarRef)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarNotice, setAvatarNotice] = useState<string>()
  const avatarPicker = useRef<HTMLInputElement | null>(null)
  const avatarUrl = useMemberAvatarUrl(memberAvatars, avatarRef)
  // The portrait answers to decoded bytes, not to a stored reference: a file
  // this browser cannot read has to fall back to the initial exactly as a
  // removed one does, or the dialog would show a blank circle and call it saved.
  const avatar = useAvatarImage(avatarUrl)
  const [personaNotice, setPersonaNotice] = useState<string>()
  const [personaCopied, setPersonaCopied] = useState(false)
  const agentMdPath = status.member.agentMdPath
  /**
   * Ask the Host to open this Member's `agent.md`.
   *
   * The path goes over exactly as the projection reported it, and a refusal
   * lands as a readable failure beside the path rather than as a silent
   * no-op — the reader still gets what they came for, which is the way to the
   * file. Nothing here is an error the dialog should swallow.
   */
  const openPersona = async (): Promise<void> => {
    if (agentMdPath === undefined) return
    setPersonaNotice(undefined)
    const failure = await openMemberPersonaPath(agentMdPath)
    if (failure !== null) setPersonaNotice(t('memberPersonaOpenFailed', { message: failure }))
  }
  const { saving, error, pendingRequest, save } = useEditDialogSave({
    save: updateMember,
    onCommitted,
    onClose,
  })
  const dirty = handle.trim() !== status.member.handle || description.trim() !== status.member.description
    || !sameModel(model, status.member.model)
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedHandle = handle.trim()
    const normalizedDescription = description.trim()
    if (saving || !dirty || normalizedHandle.length === 0) return
    const payload = {
      memberId,
      handle: normalizedHandle,
      description: normalizedDescription,
      // Only the model is stated: an absent model would keep the stored
      // override, so following the Host default has to say `null` explicitly.
      // Capabilities stay out of the payload — the editor owns no UI for them,
      // and an absent field now leaves any Remote-written override alone.
      model: model ?? null,
    }
    const samePending = pendingRequest.current !== undefined && pendingRequest.current.memberId === payload.memberId
      && pendingRequest.current.handle === payload.handle && pendingRequest.current.description === payload.description
      && sameModel(pendingRequest.current.model, model)
    const request: AgentTeamUpdateMemberRequest = samePending ? pendingRequest.current! : {
      requestId: mintRequestId(),
      ...payload,
    }
    await save(request)
  }

  /**
   * Store one picture and record its reference on this Member.
   *
   * Bytes first, then the reference, the same order the Human's own settings
   * page uses: a failure between the two leaves an avatar nobody points at,
   * which is invisible, rather than a reference to bytes nobody can load, which
   * is a broken picture. The save that follows is the editor's own, so an
   * unsaved name change is not smuggled along by an avatar upload.
   */
  const pickAvatar = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setAvatarNotice(undefined)
    if (!file.type.startsWith('image/')) {
      setAvatarNotice(t('memberAvatarNotImage'))
      return
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarNotice(t('memberAvatarTooLarge'))
      return
    }
    setAvatarBusy(true)
    try {
      const put = await putMemberAvatar({
        name: file.name,
        ...(file.type === '' ? {} : { mediaType: file.type }),
        bytesBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      })
      if (!put.ok) {
        setAvatarNotice(t('memberAvatarFailed', { message: put.error.message }))
        return
      }
      const saved = await updateMember({ requestId: mintRequestId(), memberId, handle: status.member.handle, description: status.member.description, avatarRef: put.value.avatarRef })
      if (!saved.ok) {
        setAvatarNotice(t('memberAvatarFailed', { message: saved.error.message }))
        return
      }
      setAvatarRef(put.value.avatarRef)
      await onCommitted()
    } finally {
      setAvatarBusy(false)
    }
  }

  const removeAvatar = async (): Promise<void> => {
    setAvatarNotice(undefined)
    const current = avatarRef
    if (current === undefined) return
    setAvatarBusy(true)
    try {
      await removeMemberAvatar({ avatarRef: current })
      const cleared = await updateMember({ requestId: mintRequestId(), memberId, handle: status.member.handle, description: status.member.description, avatarRef: null })
      if (!cleared.ok) {
        setAvatarNotice(t('memberAvatarFailed', { message: cleared.error.message }))
        return
      }
      setAvatarRef(undefined)
      await onCommitted()
    } finally {
      setAvatarBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('editAgent')}
      description={`@${status.member.handle}`}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<><Button variant="outline" disabled={saving} onClick={onClose}>{t('cancel')}</Button><Button type="submit" form="team-agent-edit-form" variant="primary" disabled={saving || !dirty || handle.trim().length === 0}>{saving ? t('editSaving') : t('editSave')}</Button></>}
    >
      <form id="team-agent-edit-form" className={createCss.form} onSubmit={event => { void submit(event) }}>
        <div className={createCss.field}>
          <span>{t('agentAvatar')}</span>
          <div className={createCss.avatarRow}>
            <MemberAvatarSeat memberId={memberId} handle={handle} avatarUrl={avatar.src} size={64} label={t('agentAvatar')} />
            <input
              ref={avatarPicker}
              type="file"
              accept="image/*"
              tabIndex={-1}
              aria-hidden="true"
              hidden
              onChange={event => { void pickAvatar(event.target.files?.[0]); event.target.value = '' }}
            />
            <Button variant="outline" disabled={avatarBusy || saving} onClick={() => { avatarPicker.current?.click() }}>
              {avatarBusy ? t('memberAvatarUploading') : avatarRef === undefined ? t('memberAvatarUpload') : t('memberAvatarReplace')}
            </Button>
            {avatarRef !== undefined && <Button disabled={avatarBusy || saving} onClick={() => { void removeAvatar() }}>{t('memberAvatarRemove')}</Button>}
          </div>
          {/* D6: the face a Human just replaced does not turn up on that
              Member's already-running session — the session read the record
              when it started, and the change is picked up on the next
              activation. Saying so here is what stops "I uploaded it and it
              did not change" from reading as a failure. */}
          <small className={createCss.editHint}>{t('memberAvatarNextActivation')}</small>
          {avatarNotice !== undefined && <small className={createCss.error} role="alert">{avatarNotice}</small>}
        </div>
        {agentMdPath !== undefined && <div className={createCss.field}>
          <span>{t('memberPersona')}</span>
          <div className={createCss.avatarRow}>
            <Button variant="outline" onClick={() => { void openPersona() }}>{t('memberPersonaOpen')}</Button>
            <Button
              disabled={personaCopied}
              onClick={() => { void writeClipboard(agentMdPath).then(accepted => { if (accepted) setPersonaCopied(true) }) }}
            >
              {personaCopied ? t('memberPersonaCopied') : t('memberPersonaCopyPath')}
            </Button>
          </div>
          {/* The path is shown, not just offered: a Host that cannot open it
              still leaves the reader able to find the file themselves, and the
              hint says that is what this is for. */}
          <small className={createCss.editHint}>{t('memberPersonaPathHint')}</small>
          <code className={createCss.pathText}>{agentMdPath}</code>
          {personaNotice !== undefined && <small className={createCss.error} role="alert">{personaNotice}</small>}
        </div>}
        <label className={createCss.field}>
          <span>{t('agentName')}</span>
          <Input className={createCss.input!} value={handle} onChange={event => { setHandle(event.target.value); pendingRequest.current = undefined }} disabled={saving} autoFocus />
        </label>
        <label className={createCss.field}>
          <span>{t('agentDescription')}{t('optionalSuffix')}</span>
          <Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} onChange={event => { setDescription(event.target.value); pendingRequest.current = undefined }} disabled={saving} />
        </label>
        <ModelPickerField model={model} onModelChange={choice => { pendingRequest.current = undefined; setModel(choice) }} loadModels={loadModels} disabled={saving} t={t} />
        {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      </form>
    </Modal>
  )
}

export function sameModel(left: AgentTeamModelSelection | null | undefined, right: AgentTeamModelSelection | null | undefined): boolean {
  // `null` and an absent field both mean "no override", so they are the same
  // state even though the update request distinguishes them.
  if (left === undefined || left === null) return right === undefined || right === null
  if (right === undefined || right === null) return false
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}
