import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: brings `ctx.sidebarRight` onto the Context this file already uses.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamArchiveChannelRequest,
  AgentTeamArchiveMemberRequest,
  AgentTeamClientMemberStatus,
  AgentTeamInboxRequest,
  AgentTeamHumanTodoActionRequest,
  AgentTeamHumanTodoListRequest,
  AgentTeamSendMessageRequest,
  AgentTeamThreadHistoryRequest,
  AgentTeamThreadObservationsRequest,
  AgentTeamThreadReadRequest,
  AgentTeamCreateChannelRequest,
  AgentTeamGetAttachmentRequest,
  AgentTeamJoinWorkspaceRequest,
  AgentTeamLeaveWorkspaceRequest,
  AgentTeamMembersRequest,
  AgentTeamPromoteThreadRequest,
  AgentTeamPutAttachmentRequest,
  AgentTeamRecoverMemberRequest,
  AgentTeamClearMemberContextRequest,
  AgentTeamReplyRequest,
  AgentTeamResolveMessageRefsRequest,
  AgentTeamResolveTaskRefsRequest,
  AgentTeamResolveThreadRefsRequest,
  AgentTeamTaskRequest,
  AgentTeamGetMemberAvatarRequest,
  AgentTeamPutMemberAvatarRequest,
  AgentTeamRemoveMemberAvatarRequest,
  AgentTeamRemoveThreadMemberRequest,
  AgentTeamUpdateChannelRequest,
  AgentTeamUpdateMemberRequest,
  AgentTeamSetPresidentRequest,
  AgentTeamViewRequest,
  AgentTeamMessageAttachment,
} from '@contexera/dsh-agent-team/types'
import agentTeamRemote from '@contexera/dsh-agent-team/remote'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { TeamSettingsSection } from './TeamSettingsSection.tsx'
import { TeamContextJudgeCheck } from './context-judge.ts'
import { TeamJudgeForm, TeamJudgeFormSeat, type TeamJudgeSection } from './judge-form.ts'
import { TeamHumanIdentity } from './human-identity.ts'
// The Member side of the same idea: a picture resolved per reference and shared
// by every seat that draws that Member. Kept apart from the Human's identity so
// a row cannot reach the wrong person's bytes.
import { TeamMemberAvatars } from './member-avatars.ts'
import { TeamReplyCapabilities, type TeamReplyCapabilitiesFace } from './reply-capabilities.ts'
import { TeamEnvironmentCheck } from './environment-check.ts'
import { bytesToBase64 } from './attachment-preview.ts'
import { openMemberPersonaPath } from './member-persona-path.ts'
import { openAttachmentInSidebar } from './attachment-open.ts'
import { TEAM_ENTRY_ID, TeamNavigation } from './navigation.ts'
import { TeamChangeStream, TeamReadStream, type TeamChangeListener, type TeamChangeScope } from './team-changes.ts'
import { TeamQueries, type TeamQueryIdentity } from './team-queries.ts'
import { TeamDraftStore } from './drafts.ts'
import { TeamFooterAction } from './TeamFooterAction.tsx'
import { TeamMembersAction } from './TeamMembersAction.tsx'
import { TeamConversation } from './TeamConversation.tsx'
import { TeamWorkspaceBrowser } from './TeamWorkspaceBrowser.tsx'
import { en, zh, type TeamKey } from './locales.ts'

export type { TeamMode, TeamNavigationActions, TeamNavigationSnapshot } from './navigation.ts'
export type { TeamKey } from './locales.ts'
export { TeamNavigation } from './navigation.ts'

const NS = 'team'

/**
 * The Team Host row's settings namespace. Spelled here rather than imported,
 * because a client package must not depend on a Host package — the profile, the
 * judge's endpoint, and the gate's thresholds all live in this one row section,
 * and each settings page renders only the group it owns.
 */
const TEAM_SETTINGS_NS = 'wowyuarm-agent-team-host'

export const inject = [
  'slots', 'workspaces', 'layout', 'locale', 'remote', 'remote.session', 'sessions', 'connection', 'conversation', 'uiWorkspace',
]

/**
 * 0.1.7 moved the conversation selection into the workspace service: the
 * rendered session is the one holding its `mainView` reference (the shipped
 * consumers read the same projection), so the Team client reads the selection
 * through retention instead of a service-owned `current`.
 */
function currentMainSessionId(ctx: ClientContext): AgentTeamClientMemberStatus['member']['sessionId'] | undefined {
  const sessions = ctx.sessions as unknown as ISessions
  return Object.values(sessions.list.getSnapshot().byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/**
 * Session ids this client opened as Member views, per client instance. The
 * 0.1.7 workspace service exposes no clear, so a dead return target leaves
 * the departed Member selection in place; excluding Member sessions from the
 * next capture keeps that stale selection from becoming a false return
 * target.
 */
const openedMemberSessions = new WeakMap<ClientContext, Set<string>>()

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    team: TeamKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamNavigation: TeamNavigation
    teamDrafts: TeamDraftStore
    teamQueries: TeamQueries
  }
}

/**
 * Enter the mode from its own entry. Team mode owns the conversation seat
 * rather than a panel of its own, so the entry clears whatever global panel
 * holds the column and then flips the mode: the mode's seat is the `main`
 * shadow registered under the reserved 'conversation' key, and the shell draws
 * the right rail only while no panel is selected. Clearing first also keeps the
 * ownership effect below from reading the mode's own arrival as a foreign panel
 * taking the column.
 * @param ctx - client root context carrying the layout store.
 * @param navigation - the mode store this entry flips.
 */
function enterTeamFromUi(ctx: ClientContext, navigation: TeamNavigation): void {
  ctx.layout.selectPanel(null)
  navigation.actions().enterTeam()
}

/**
 * Leaving the mode stands the Team seat down on its own: the mode is the one
 * criterion the seat reads, so the entry only has to close an embedded Member
 * Session view (its column ownership) and flip the mode.
 * @param navigation - the mode store this entry flips.
 */
function leaveTeamFromUi(navigation: TeamNavigation): void {
  navigation.actions().exitMemberSession()
  navigation.actions().leaveTeam()
}

/**
 * Register the Team's entry at the sidebar's foot, beside the shipped Settings
 * row. The entry owns no panel: the mode's own seat is the `main` shadow
 * registered under the reserved 'conversation' key, which paints while
 * `teamNavigation.mode` is 'team' and no Member Session view is embedded (see
 * the panel-ownership effect in `applyUi`).
 */
function registerTeamPanel(
  ctx: ClientContext,
  navigation: TeamNavigation,
  queries: TeamQueries,
  reads: TeamReadStream,
  drafts: TeamDraftStore,
  humanIdentity: TeamHumanIdentity,
  memberAvatars: TeamMemberAvatars,
  replyCapabilities: TeamReplyCapabilitiesFace,
): void {
  const sharedRemotes = teamSharedRemotes(ctx, navigation, queries, reads, drafts, humanIdentity, memberAvatars, replyCapabilities)
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: TEAM_ENTRY_ID,
    order: 100,
    locale: NS,
    inject: () => ({
      navigation,
      ...navigation.actions(),
      // The mode's own entry: it takes the column for the conversation seat the
      // Team stands in for, and the mode is what the seat reads.
      enterTeam: () => { enterTeamFromUi(ctx, navigation) },
      // And the entry is the way out, closing an embedded Member Session view
      // with it.
      leaveTeam: () => { leaveTeamFromUi(navigation) },
    }),
  }, TeamFooterAction as never))
}

/**
 * Embed one Member's Session in the conversation seat while staying in Team
 * mode: the Team seat stands down for Member Session views, so the shipped
 * conversation root renders the selected Member Session inside the Team shell.
 * The view clears the panel to own the column — a global panel that held it
 * would paint over the Member conversation — and the mode keeps the sidebar, so
 * the reader comes back to the Team page they left when the view closes.
 */
function openMemberSessionImpl(
  ctx: ClientContext,
  navigation: TeamNavigation,
  sessionId: AgentTeamClientMemberStatus['member']['sessionId'],
  /** Surfaces a failure to the row instead of leaving the click silent. */
  reportFailure?: (message: string) => void,
): void {
  const snapshot = navigation.getSnapshot()
  const current = currentMainSessionId(ctx)
  // The return target is captured on first entry only — switching between
  // Member Sessions must keep pointing at the Human's original session.
  const memberSessions = openedMemberSessions.get(ctx) ?? new Set<string>()
  openedMemberSessions.set(ctx, memberSessions)
  memberSessions.add(sessionId)
  const returnTo = snapshot.memberSessionId === undefined && current !== undefined && current !== sessionId && !memberSessions.has(current) ? current : undefined
  navigation.actions().enterMemberSession(sessionId, returnTo)
  ctx.layout.selectPanel(null)
  // `openSession` is a synchronous void: its failure (an id the Client's
  // Session catalog does not carry yet — the window right after a Member is
  // created) would otherwise vanish, leaving the sidebar marking a Session
  // the seat never showed. Undo the navigation and let the caller say so.
  try {
    ctx.uiWorkspace.openSession(sessionId)
  } catch (cause) {
    if (snapshot.memberSessionId !== undefined) navigation.actions().enterMemberSession(snapshot.memberSessionId, undefined)
    else navigation.actions().exitMemberSession()
    reportFailure?.(cause instanceof Error ? cause.message : String(cause))
  }
}

/** The roster query's identity: one key per Workspace, invalidated by presence and workspace changes. */
function membersQuery(request: AgentTeamMembersRequest): TeamQueryIdentity {
  return {
    key: `members:${request.workspaceId}`,
    // Only the scopes that actually carry roster facts: the Host wakes this
    // Workspace scope for every member-level commit and presence scopes for
    // run state. The scope-less stream is a superset of projection wakes —
    // every scope-less delivery that touches this roster has also woken this
    // Workspace — so letting it in adds no needed invalidation, only
    // unrelated ones that cost a redundant read (issue 03 criterion 4).
    covers: scope => scope !== undefined
      && (scope.kind === 'presence' || scope.kind === 'workspace') && scope.workspaceId === request.workspaceId,
  }
}

/**
 * The Inbox query's identity: one key per Workspace and page size. Its data
 * moves with any shared-projection commit — a mention can land in any Thread —
 * so the scope-less stream is this query's home surface, not an exception to
 * the narrow-scope rule; presence wakes never reach it because they change no
 * inbox fact.
 */
function inboxQuery(request: AgentTeamInboxRequest): TeamQueryIdentity {
  return {
    key: `inbox:${request.workspaceId}:${request.limit ?? 'all'}`,
    covers: scope => scope === undefined
      || (scope.kind === 'workspace' && scope.workspaceId === request.workspaceId)
      || scope.kind === 'channel'
      || scope.kind === 'thread',
  }
}

/**
 * The Human to-do query's identity: one key per Workspace and per scope, so a
 * Thread's own list and the Workspace-wide Channel counts never share an answer.
 * To-do facts move with any ledger commit — a dispatch can land in any Thread —
 * so this query answers to the scope-less stream the way the Inbox does;
 * presence wakes change no to-do and never reach it.
 */
function humanTodosQuery(request: AgentTeamHumanTodoListRequest): TeamQueryIdentity {
  return {
    key: `human-todos:${request.workspaceId}:${request.threadRef ?? 'all'}`,
    covers: scope => scope === undefined
      || (scope.kind === 'workspace' && scope.workspaceId === request.workspaceId)
      || scope.kind === 'channel'
      || scope.kind === 'thread',
  }
}

/** Remote bindings shared by every Team slot; a surface-specific seat extends them below. */
function teamSharedRemotes(
  ctx: ClientContext,
  navigation: TeamNavigation,
  queries: TeamQueries,
  reads: TeamReadStream,
  drafts: TeamDraftStore,
  humanIdentity: TeamHumanIdentity,
  memberAvatars: TeamMemberAvatars,
  replyCapabilities: TeamReplyCapabilitiesFace,
): Record<string, unknown> {
  return {
    loadChannels: (request: AgentTeamViewRequest) => ctx.remote.agentTeam.view(request),
    // To-do facts move with any ledger commit in the Workspace — a dispatch can
    // land in any Thread — so this query answers to the same broad surface the
    // Inbox does, keyed by whether the caller asked for one Thread or the
    // Workspace-wide counts so the two shapes never share an answer.
    loadHumanTodos: (request: AgentTeamHumanTodoListRequest) => queries.read(humanTodosQuery(request), () => ctx.remote.agentTeam.humanTodos(request)),
    changeHumanTodo: (request: AgentTeamHumanTodoActionRequest) => ctx.remote.agentTeam.changeHumanTodo(request),
    loadInbox: (request: AgentTeamInboxRequest) => queries.read(inboxQuery(request), () => ctx.remote.agentTeam.inbox(request)),
    subscribeReads: (listener: () => void) => reads.subscribe(listener),
    // Change subscriptions fold through the read layer so each dispatch
    // invalidates the queries it covers before any consumer re-reads.
    subscribeChanges: (scope: TeamChangeScope, listener: TeamChangeListener) => queries.subscribeChanges(scope, listener),
    drafts,
    humanIdentity,
    memberAvatars,
    replyCapabilities,
    loadMembers: (request: AgentTeamMembersRequest) => queries.read(membersQuery(request), () => ctx.remote.agentTeam.members(request)),
    updateChannel: (request: AgentTeamUpdateChannelRequest) => ctx.remote.agentTeam.updateChannel(request),
    archiveChannel: (request: AgentTeamArchiveChannelRequest) => ctx.remote.agentTeam.archiveChannel(request),
    updateMember: (request: AgentTeamUpdateMemberRequest) => ctx.remote.agentTeam.updateMember(request),
    setPresident: (request: AgentTeamSetPresidentRequest) => ctx.remote.agentTeam.setPresident(request),
    putMemberAvatar: (request: AgentTeamPutMemberAvatarRequest) => ctx.remote.agentTeam.putMemberAvatar(request),
    getMemberAvatar: (request: AgentTeamGetMemberAvatarRequest) => ctx.remote.agentTeam.getMemberAvatar(request),
    removeMemberAvatar: (request: AgentTeamRemoveMemberAvatarRequest) => ctx.remote.agentTeam.removeMemberAvatar(request),
    recoverMember: (request: AgentTeamRecoverMemberRequest) => ctx.remote.agentTeam.recoverMember(request),
    clearMemberContext: (request: AgentTeamClearMemberContextRequest) => ctx.remote.agentTeam.clearMemberContext(request),
    archiveMember: (request: AgentTeamArchiveMemberRequest) => ctx.remote.agentTeam.archiveMember(request),
    joinWorkspace: (request: AgentTeamJoinWorkspaceRequest) => ctx.remote.agentTeam.joinWorkspace(request),
    leaveWorkspace: (request: AgentTeamLeaveWorkspaceRequest) => ctx.remote.agentTeam.leaveWorkspace(request),
    // The Host-scoped catalog needs no live Member, so suspended ones stay editable too.
    loadModels: () => ctx.remote.session.modelCatalog(),
    // The absolute path travels verbatim: the Host validates it by resolving it
    // against its own filesystem, so a path rewritten or re-joined here could
    // stop matching and come back as a bad request instead of an open file.
    openMemberPersonaPath: (path: string) => openMemberPersonaPath(ctx.remote.session, path),
    openMemberSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId'], reportFailure?: (message: string) => void) => {
      openMemberSessionImpl(ctx, navigation, sessionId, reportFailure)
    },
  }
}

/**
 * The injected share one Team seat receives: the mode's own state and actions,
 * every shared remote, and the writes only that seat performs. `main` writes the
 * conversation, the sidebar's browser seat writes the roster and Channels.
 */
function teamSeatInject(
  ctx: ClientContext,
  navigation: TeamNavigation,
  reads: TeamReadStream,
  sharedRemotes: Record<string, unknown>,
  name: 'sidebar.workspaces' | 'main' | 'sidebar.settings',
  extraInject?: () => Record<string, unknown>,
): Record<string, unknown> {
  return {
    navigation,
    ...extraInject?.(),
    ...navigation.actions(),
    // Leaving Team mode is also closing the Member Session view it may be
    // showing: the entry is a destination, and the mode's own exit stands the
    // Team seat down instead of leaving a Member view behind it.
    leaveTeam: () => { leaveTeamFromUi(navigation) },
    ...sharedRemotes,
    ...(name === 'main' ? {
      // A committed durable read consumes this reader's mention markers; the
      // Host's changes stream never wakes on reads, so the Human's badge
      // refreshes from the completed read itself.
      readThread: async (request: AgentTeamThreadReadRequest) => {
        const result = await ctx.remote.agentTeam.readThread(request)
        if (result.ok) reads.bump()
        return result
      },
      loadThreadHistory: (request: AgentTeamThreadHistoryRequest) => ctx.remote.agentTeam.threadHistory(request),
      threadObservations: (request: AgentTeamThreadObservationsRequest) => ctx.remote.agentTeam.threadObservations(request),
      removeThreadMember: (request: AgentTeamRemoveThreadMemberRequest) => ctx.remote.agentTeam.removeThreadMember(request),
      sendMessage: (request: AgentTeamSendMessageRequest) => ctx.remote.agentTeam.sendMessage(request),
      putAttachment: (request: AgentTeamPutAttachmentRequest) => ctx.remote.agentTeam.putAttachment(request),
      getAttachment: (request: AgentTeamGetAttachmentRequest) => ctx.remote.agentTeam.getAttachment(request),
      // The Sidebar face is read at click time, not captured here: which
      // Session is on screen changes as the Human moves around, and an
      // address built against a stale Session would open in the wrong place
      // or in none.
      // Read per click, and optionally: a host without the right Sidebar still
      // renders the block (the manifest inject is what makes the service
      // available there, while declaring it in `inject` here would suspend the
      // whole client on hosts that do not ship one). Absent, the gesture says
      // there is nothing on screen to open the file in.
      openAttachment: (attachment: AgentTeamMessageAttachment) => openAttachmentInSidebar({
        mounted: () => ctx.reflect.get('sidebarRight', false)?.mounted.getSnapshot() as string | undefined,
        open: address => { ctx.reflect.get('sidebarRight', false)?.openResource(address) },
        openTabs: () => ctx.reflect.get('sidebarRight', false)?.openTabs.getSnapshot() ?? [],
      }, ctx.remote.agentTeam, attachment),
      reply: (request: AgentTeamReplyRequest) => ctx.remote.agentTeam.reply(request),
      changeTask: (request: AgentTeamTaskRequest) => ctx.remote.agentTeam.changeTask(request),
      promoteThread: (request: AgentTeamPromoteThreadRequest) => ctx.remote.agentTeam.promoteThread(request),
      resolveTaskRefs: (request: AgentTeamResolveTaskRefsRequest) => ctx.remote.agentTeam.resolveTaskRefs(request),
      resolveThreadRefs: (request: AgentTeamResolveThreadRefsRequest) => ctx.remote.agentTeam.resolveThreadRefs(request),
      resolveMessageRefs: (request: AgentTeamResolveMessageRefsRequest) => ctx.remote.agentTeam.resolveMessageRefs(request),
    } : {}),
    ...(name === 'sidebar.workspaces' ? {
      addMember: (request: AgentTeamAddMemberRequest) => ctx.remote.agentTeam.addMember(request),
      createChannel: (request: AgentTeamCreateChannelRequest) => ctx.remote.agentTeam.createChannel(request),
    } : {}),
  }
}

function registerModeShadow<T extends object>(
  ctx: ClientContext,
  navigation: TeamNavigation,
  queries: TeamQueries,
  reads: TeamReadStream,
  drafts: TeamDraftStore,
  humanIdentity: TeamHumanIdentity,
  memberAvatars: TeamMemberAvatars,
  replyCapabilities: TeamReplyCapabilitiesFace,
  name: 'sidebar.workspaces' | 'main' | 'sidebar.settings',
  component: T,
  extraInject?: () => Record<string, unknown>,
  // Keyed seats (`main`) address one panel by key; the reserved 'conversation'
  // key is where the shipped Conversation registers, so the Team seat shadows
  // that same panel instead of adding a second one.
  entryKey?: string,
): void {
  const sharedRemotes = teamSharedRemotes(ctx, navigation, queries, reads, drafts, humanIdentity, memberAvatars, replyCapabilities)
  ctx.slots.inject(name, () => {
    let dispose: (() => void) | undefined
    const reconcile = (): void => {
      const snapshot = navigation.getSnapshot()
      // The main panel seat yields to the shipped conversation root while a
      // Member Session view is embedded; both sidebar seats stay shadowed so
      // the Team chrome keeps working around the Member conversation.
      const active = snapshot.mode === 'team' && !(name === 'main' && snapshot.memberSessionId !== undefined)
      if (active && dispose === undefined) {
        dispose = ctx.slots.register({
          name,
          ...(entryKey === undefined ? {} : { key: entryKey }),
          priority: -100,
          locale: NS,
          inject: () => teamSeatInject(ctx, navigation, reads, sharedRemotes, name, extraInject),
        } as never, component as never)
      } else if (!active && dispose !== undefined) {
        dispose()
        dispose = undefined
      }
    }
    const unsubscribe = navigation.subscribe(reconcile)
    reconcile()
    return () => {
      unsubscribe()
      dispose?.()
      dispose = undefined
    }
  })
}

function applyUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-team: dictionaries')

  const navigation = new TeamNavigation()
  const disposeNavigation = ctx.reflect.provide('teamNavigation', navigation)
  const drafts = new TeamDraftStore()
  const disposeDrafts = ctx.reflect.provide('teamDrafts', drafts)
  // The Human's own identity: one projection every seat reads, refreshed once
  // after a profile write so a rename reaches the timeline and the member refs
  // without a reload. Reads are demand-driven — the first seat that subscribes
  // starts the read. The profile page writes back through the Team Remote, so
  // the Client never names the Host's own profile entry.
  const humanIdentity = new TeamHumanIdentity({
    loadProfile: () => ctx.remote.agentTeam.humanProfile({}),
    loadAvatarUrl: async (avatarRef: string) => {
      // Avatar bytes ride the dedicated avatar Remote (never the TTL-bound
      // attachment cache); a data URL is what an `<img>` seat can show directly.
      const result = await ctx.remote.agentTeam.getHumanAvatar({ avatarRef })
      if (!result.ok || !result.value.mediaType.startsWith('image/')) return null
      return `data:${result.value.mediaType};base64,${result.value.bytesBase64}`
    },
  })
  // Member faces: one map from the reference a Member record carries to the
  // bytes a seat can draw. Separate from the Human's identity above because the
  // two are different people — see the note on the store itself.
  const memberAvatars = new TeamMemberAvatars({
    loadAvatarUrl: async (avatarRef: string) => {
      const result = await ctx.remote.agentTeam.getMemberAvatar({ avatarRef })
      if (!result.ok || !result.value.mediaType.startsWith('image/')) return null
      return `data:${result.value.mediaType};base64,${result.value.bytesBase64}`
    },
  })
  // The local environment check: a fact about this installation rather than
  // about the Human, so it is its own projection and never a field of the
  // identity above. Read once, on the first subscriber, and never written back.
  const environment = new TeamEnvironmentCheck({
    loadEnvironment: () => ctx.remote.agentTeam.environment({}),
  })
  // The long-gap gate's judge: what the Host answers about reachability, and
  // the thresholds in force. Its own projection rather than a field of the
  // environment check, because it re-reads after every write that can mount or
  // unmount the judge while the environment verdict is settled once.
  const contextJudge = new TeamContextJudgeCheck({
    loadContextJudge: () => ctx.remote.agentTeam.contextJudge({}),
  })
  // The settings page's endpoint form. It is held in a seat rather than handed
  // over as a value, because the service it is built over may arrive after the
  // page's injected props were computed — and a slot entry's props are computed
  // once and cached, so a value would freeze the answer.
  const judgeForm = new TeamJudgeFormSeat()
  ctx.effect(() => () => {
    navigation.dispose()
    drafts.dispose()
    humanIdentity.dispose()
    memberAvatars.dispose()
    environment.dispose()
    contextJudge.dispose()
    judgeForm.dispose()
    void disposeNavigation()
    void disposeDrafts()
  }, 'agent-team: navigation service')

  // The one restore owner: leaving an embedded Member Session view must
  // rebind the underlying selection, or the departed Member session stays the
  // workspace service's `mainView` retention into the next Member entry's
  // return-target capture. Takeover is conditional — only when the selection
  // still IS the departed Member session — so a selection someone else made
  // in the meantime survives. A dead return target keeps the departed
  // selection: 0.1.7 exposes no public clear, and the retention is inert
  // behind the Team seat until the next open.
  ctx.effect(() => {
    let previous = navigation.getSnapshot()
    const restore = (): void => {
      const snapshot = navigation.getSnapshot()
      const departed = previous.memberSessionId
      const returnTo = previous.returnToSessionId
      previous = snapshot
      if (departed === undefined || snapshot.memberSessionId !== undefined) return
      if (currentMainSessionId(ctx) !== departed) return
      if (returnTo !== undefined && (ctx.sessions as unknown as ISessions).list.getSnapshot().byId[returnTo] !== undefined) ctx.uiWorkspace.openSession(returnTo)
    }
    const unsubscribe = navigation.subscribe(restore)
    return () => {
      unsubscribe()
      restore()
    }
  }, 'agent-team: member session restore')

  const changes = new TeamChangeStream(ctx.remote)
  ctx.effect(() => () => changes.dispose(), 'agent-team: change subscriptions')
  // Every consumer's data read funnels through this one owner: it shares an
  // in-flight read per query identity, folds each change dispatch into query
  // invalidations before consumers re-read, and drops responses a newer
  // response has superseded (counters only — no response body ever logged).
  const queries = new TeamQueries(changes)
  const disposeQueries = ctx.reflect.provide('teamQueries', queries)
  ctx.effect(() => () => { void disposeQueries(); queries.dispose() }, 'agent-team: shared reads')
  // The Harness resumes a live generation across reconnects, but a stream that
  // already ended for good is this layer's to rebuild — and a new Host generation
  // is the one moment the scope it was waiting for can be there again. A new
  // generation also restarts the presence epoch, so the read layer's watermarks
  // reset and in-flight reads stop being joinable.
  ctx.on('connection/reset', () => { changes.recover(); queries.newGeneration() })
  const reads = new TeamReadStream()

  const loadMemberGroups = async () => {
    const workspaces = ctx.workspaces.list.getSnapshot().items
    const groups = await Promise.all(workspaces.map(async workspace => {
      const result = await ctx.remote.agentTeam.members({ workspaceId: workspace.workspaceId })
      if (!result.ok) throw new Error(result.error.message)
      // The members modal is a listing surface: archived Members are hidden
      // everywhere, and removed (inactive) ones never belong in a roster.
      const members = result.value.filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived')
      return { workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, members }
    }))
    return groups.filter(group => group.members.length > 0)
  }

  // One reply-capability store per Client: the settings page moves the switch
  // and refreshes it, and every surface that offers a reply reads the same
  // answer, so the affordance appears and disappears immediately.
  const replyCapabilities = new TeamReplyCapabilities(() => ctx.remote.agentTeam.replySettings())
  registerTeamPanel(ctx, navigation, queries, reads, drafts, humanIdentity, memberAvatars, replyCapabilities)

  registerModeShadow(ctx, navigation, queries, reads, drafts, humanIdentity, memberAvatars, replyCapabilities, 'sidebar.workspaces', TeamWorkspaceBrowser as never)
  registerModeShadow(ctx, navigation, queries, reads, drafts, humanIdentity, memberAvatars, replyCapabilities, 'main', TeamConversation as never, undefined, 'conversation')
  registerModeShadow(ctx, navigation, queries, reads, drafts, humanIdentity, memberAvatars, replyCapabilities, 'sidebar.settings', TeamMembersAction as never, () => ({ loadMemberGroups, memberAvatars }))

  // One criterion says whether Team mode stands: `TeamNavigation.mode`, the
  // store the Team seat's own registration reads. The mode owns the
  // conversation seat instead of a panel, so a global panel taking the column is
  // the one thing that ends it — the shell would paint that panel over the Team
  // seat anyway, and the right rail it hides belongs to the conversation the
  // Team stands in for. A null selection is left alone: that is the mode's own
  // column, and a Member Session view clears the panel to own it in turn.
  ctx.effect(() => {
    const sync = (): void => {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === null) return
      if (navigation.getSnapshot().mode === 'team') navigation.actions().leaveTeam()
    }
    const unsubscribe = ctx.layout.panelInfo.subscribe(sync)
    sync()
    return unsubscribe
  }, 'agent-team: panel ownership')

  // Team mode's own marker on the document: the Team sidebar's CSS keys off it
  // (the shell's New Session button stands down), and it is the one place that
  // says the mode rather than the selection.
  ctx.effect(() => {
    const apply = (): void => {
      if (typeof document === 'undefined') return
      if (navigation.getSnapshot().mode === 'team') document.documentElement.dataset.agentTeamMode = 'team'
      else delete document.documentElement.dataset.agentTeamMode
    }
    const unsubscribe = navigation.subscribe(apply)
    apply()
    return () => {
      unsubscribe()
      if (typeof document !== 'undefined') delete document.documentElement.dataset.agentTeamMode
    }
  }, 'agent-team: mode marker')

  // The Team's settings page: one settings section, ordered between General (0)
  // and Models (10) so it sits near the top. It holds two groups that write
  // through two different documents: identity goes through the Team Remote,
  // which answers with the Host's own rejection reason (a name collides, an
  // empty one), and the shared identity re-reads afterwards, so a rename lands
  // in the timeline and the member refs at the same moment the page shows it.
  //
  // The judge's endpoint is one group of the Team row's settings section, so it
  // is offered only while this deployment serves a settings document: the page
  // is registered here regardless, because identity is reachable without one,
  // and the seat above stays empty when there is none. The service is read
  // through `ctx.get` rather than a hard `inject` for the same reason — a
  // deployment without the settings UI keeps the rest of the Team.
  ctx.inject(['configForms'], (scope: ClientContext) => {
    const form = new TeamJudgeForm(scope.configForms.get<TeamJudgeSection>(TEAM_SETTINGS_NS), contextJudge)
    judgeForm.hold(form)
    scope.effect(() => () => {
      judgeForm.release(form)
      form.dispose()
    }, 'agent-team: judge settings form')
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'team-settings',
    order: 5,
    label: () => ctx.locale.bind(NS)('teamSettingsNav'),
    locale: NS,
    inject: () => ({
      identity: humanIdentity,
      replyCapabilities,
      environment,
      judge: contextJudge,
      judgeForm,
      // The key's literal never rides a response; the describe mirror is what
      // says whether one is stored.
      keyConfigured: (): boolean => ctx.get('configForms')?.describe().getSnapshot().view?.namespaces
        .find(row => row.ns === TEAM_SETTINGS_NS)?.secrets
        .some(secret => secret.path.join('.') === 'jev.apiKey' && secret.set) ?? false,
      saveName: async (name: string) => {
        const saved = await ctx.remote.agentTeam.setHumanProfile({ name })
        if (!saved.ok) return saved.error.message
        await humanIdentity.refresh()
        return undefined
      },
      uploadAvatar: async (file: File) => {
        const put = await ctx.remote.agentTeam.putHumanAvatar({
          name: file.name,
          ...(file.type === '' ? {} : { mediaType: file.type }),
          bytesBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
        })
        if (!put.ok) return put.error.message
        const saved = await ctx.remote.agentTeam.setHumanProfile({ avatarRef: put.value.avatarRef })
        if (!saved.ok) return saved.error.message
        await humanIdentity.refresh()
        return undefined
      },
      removeAvatar: async () => {
        const { avatarRef } = humanIdentity.getSnapshot()
        if (avatarRef === undefined) return undefined
        // Bytes first, then the reference: a failed clear leaves a readable
        // avatar instead of a reference to bytes nobody can load.
        await ctx.remote.agentTeam.removeHumanAvatar({ avatarRef })
        const cleared = await ctx.remote.agentTeam.setHumanProfile({ avatarRef: null })
        if (!cleared.ok) return cleared.error.message
        await humanIdentity.refresh()
        return undefined
      },
    }),
  }, TeamSettingsSection as never))
}

export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(agentTeamRemote)
  ctx.effect(() => () => { void disposeRemote() }, 'agent-team: remote')
  ctx.inject(['remote.agentTeam'], ready => { applyUi(ready as ClientContext) })
}
