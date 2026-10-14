import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamArchiveChannelRequest,
  AgentTeamArchiveChannelResult,
  AgentTeamArchiveMemberRequest,
  AgentTeamArchiveMemberResult,
  AgentTeamChannelRef,
  AgentTeamClientMemberStatus,
  AgentTeamClearMemberContextRequest,
  AgentTeamClearMemberContextResult,
  AgentTeamCreateChannelRequest,
  AgentTeamCreateChannelResult,
  AgentTeamInbox,
  AgentTeamInboxRequest,
  AgentTeamHumanTodoActionRequest,
  AgentTeamHumanTodoList,
  AgentTeamHumanTodoListRequest,
  AgentTeamHumanTodoResult,
  AgentTeamJoinWorkspaceRequest,
  AgentTeamJoinWorkspaceResult,
  AgentTeamLeaveWorkspaceRequest,
  AgentTeamLeaveWorkspaceResult,
  AgentTeamGetAttachmentRequest,
  AgentTeamGetAttachmentResult,
  AgentTeamPutAttachmentRequest,
  AgentTeamPutAttachmentResult,
  AgentTeamMemberResult,
  AgentTeamAddMemberResult,
  AgentTeamRecoverMemberRequest,
  AgentTeamRecoverMemberResult,
  AgentTeamMembersRequest,
  AgentTeamReplyRequest,
  AgentTeamResolveTaskRefsRequest,
  AgentTeamResolveTaskRefsResult,
  AgentTeamResolveMessageRefsRequest,
  AgentTeamResolveMessageRefsResult,
  AgentTeamResolveThreadRefsRequest,
  AgentTeamResolveThreadRefsResult,
  AgentTeamReplyResult,
  AgentTeamConfirmationRequired,
  AgentTeamThreadHistory,
  AgentTeamThreadHistoryRequest,
  AgentTeamThreadObservations,
  AgentTeamThreadObservationsRequest,
  AgentTeamThreadReadRequest,
  AgentTeamThreadReadResult,
  AgentTeamPromoteThreadRequest,
  AgentTeamPromoteThreadResult,
  AgentTeamTaskRequest,
  AgentTeamTaskResult,
  AgentTeamSendMessageRequest,
  AgentTeamSendMessageResult,
  AgentTeamUpdateChannelRequest,
  AgentTeamUpdateChannelResult,
  AgentTeamGetMemberAvatarRequest,
  AgentTeamGetMemberAvatarResult,
  AgentTeamPutMemberAvatarRequest,
  AgentTeamPutMemberAvatarResult,
  AgentTeamRemoveMemberAvatarRequest,
  AgentTeamRemoveMemberAvatarResult,
  AgentTeamUpdateMemberRequest,
  AgentTeamView,
  AgentTeamViewRequest,
} from '@contexera/dsh-agent-team/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamNavigationActions, TeamNavigationSnapshot } from './navigation.ts'
import type { TeamChangeListener, TeamChangeScope } from './team-changes.ts'
import type { TeamDraftStore } from './drafts.ts'
import type { TeamReplyCapabilitiesSource } from './reply-capabilities.ts'
import type { TeamHumanIdentitySource } from './human-identity.ts'
import type { TeamMemberAvatars } from './member-avatars.ts'

export interface TeamNavigationSource {
  getSnapshot: () => TeamNavigationSnapshot
  subscribe: (listener: () => void) => () => void
}

/** Subscribe to one projection scope's invalidation stream; disposal aborts the shared poll. */
export type SubscribeTeamChanges = (scope: TeamChangeScope, listener: TeamChangeListener) => () => void

/** One adapter-owned selectable reasoning effort of one model route. */
export interface TeamModelEffortOption {
  readonly id: string
  readonly name: string
}

/** One selectable model row inside one provider group of the Host catalog. */
export interface TeamModelOption {
  readonly id: string
  readonly name: string
  /** Selectable reasoning levels when the adapter exposes them. */
  readonly reasoning?: {
    readonly efforts: readonly TeamModelEffortOption[]
  }
}

/** Provider-grouped slice of the Host model catalog the editors render. */
export interface TeamModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly TeamModelOption[]
}

/** Host-scoped catalog load result; per-provider listing failures ride `failures`. */
export interface TeamModelCatalog {
  readonly groups: readonly TeamModelProviderGroup[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}

export type TeamSidebarProps = PropsRuntime<'sidebar.workspaces'>
  & PropsLocale<'team'>
  & TeamNavigationActions
  & {
    navigation: TeamNavigationSource
    loadMembers: (request: AgentTeamMembersRequest) => Promise<RemoteResult<readonly AgentTeamClientMemberStatus[]>>
    /** Human direct-only Inbox slice; the badge sums each visible Workspace's total. */
    loadInbox: (request: AgentTeamInboxRequest) => Promise<RemoteResult<AgentTeamInbox>>
    /**
     * The Host's own per-Channel to-do counts, read with no Thread scope: one
     * Channel row wears one number, and only the Host can derive it across
     * every Thread under that Channel.
     */
    loadHumanTodos: (request: AgentTeamHumanTodoListRequest) => Promise<RemoteResult<AgentTeamHumanTodoList>>
    /** Fired after every committed durable Thread read; the badge refreshes without waiting for a changes wake. */
    subscribeReads: (listener: () => void) => () => void
    subscribeChanges: SubscribeTeamChanges
    addMember: (request: AgentTeamAddMemberRequest) => Promise<RemoteResult<AgentTeamAddMemberResult>>
    loadChannels: (request: AgentTeamViewRequest) => Promise<RemoteResult<AgentTeamView>>
    createChannel: (request: AgentTeamCreateChannelRequest) => Promise<RemoteResult<AgentTeamCreateChannelResult>>
    updateChannel: (request: AgentTeamUpdateChannelRequest) => Promise<RemoteResult<AgentTeamUpdateChannelResult>>
    archiveChannel: (request: AgentTeamArchiveChannelRequest) => Promise<RemoteResult<AgentTeamArchiveChannelResult>>
    updateMember: (request: AgentTeamUpdateMemberRequest) => Promise<RemoteResult<AgentTeamMemberResult>>
    /**
     * Store one Member avatar's bytes and return their opaque reference. The
     * caller records that reference on the Member with `updateMember` as a
     * separate step, so a failure at either half never leaves a name pointing at
     * bytes that are not there, or bytes nobody names.
     */
    putMemberAvatar: (request: AgentTeamPutMemberAvatarRequest) => Promise<RemoteResult<AgentTeamPutMemberAvatarResult>>
    /** Read one Member avatar's bytes so the boundary page can draw them. */
    getMemberAvatar: (request: AgentTeamGetMemberAvatarRequest) => Promise<RemoteResult<AgentTeamGetMemberAvatarResult>>
    removeMemberAvatar: (request: AgentTeamRemoveMemberAvatarRequest) => Promise<RemoteResult<AgentTeamRemoveMemberAvatarResult>>
    recoverMember: (request: AgentTeamRecoverMemberRequest) => Promise<RemoteResult<AgentTeamRecoverMemberResult>>
    /**
     * Host clear-context remote kept as a hidden migration escape hatch.
     * The visible row action is retired: Members manage their own context
     * through the context_rollover tool (see docs/architecture/README.md).
     */
    clearMemberContext: (request: AgentTeamClearMemberContextRequest) => Promise<RemoteResult<AgentTeamClearMemberContextResult>>
    archiveMember: (request: AgentTeamArchiveMemberRequest) => Promise<RemoteResult<AgentTeamArchiveMemberResult>>
    joinWorkspace: (request: AgentTeamJoinWorkspaceRequest) => Promise<RemoteResult<AgentTeamJoinWorkspaceResult>>
    leaveWorkspace: (request: AgentTeamLeaveWorkspaceRequest) => Promise<RemoteResult<AgentTeamLeaveWorkspaceResult>>
    /** Session-independent Host model catalog (`llm.models`); needs no live Member. */
    loadModels: () => Promise<RemoteResult<TeamModelCatalog>>
    /** Member faces by reference, so the roster and the editor portrait draw the
     * same bytes the boundary page does instead of each loading their own. */
    memberAvatars: TeamMemberAvatars
    /**
     * Ask the Host to open one absolute path in whatever application it uses.
     *
     * Resolves `null` once the Host acknowledged, or the message to show. A
     * refusal on the Host's side and an unreachable Host both arrive here as a
     * message, because to the reader they are the same thing: no file opened.
     */
    openMemberPersonaPath: (path: string) => Promise<string | null>
    /** Embed the Member's Session conversation in the Team conversation seat. */
    openMemberSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId'], reportFailure?: (message: string) => void) => void
    selectedChannelRef?: AgentTeamChannelRef
  }

export type TeamConversationProps = PropsRuntime<'main'> & PropsLocale<'team'> & TeamNavigationActions & {
  navigation: TeamNavigationSource
  /** Keyed composer draft cache; one store per Client context. */
  drafts: TeamDraftStore
  /** The Human's own identity: the display name and avatar every seat that names or draws them reads. */
  humanIdentity: TeamHumanIdentitySource
  /** Member faces by reference; separate from the Human's identity because a
   * seat must never reach one person's bytes under another's name. */
  memberAvatars: TeamMemberAvatars
  loadChannels: (request: AgentTeamViewRequest) => Promise<RemoteResult<AgentTeamView>>
  readThread: (request: AgentTeamThreadReadRequest) => Promise<RemoteResult<AgentTeamThreadReadResult>>
  loadThreadHistory: (request: AgentTeamThreadHistoryRequest) => Promise<RemoteResult<AgentTeamThreadHistory>>
  subscribeChanges: SubscribeTeamChanges
  putAttachment: (request: AgentTeamPutAttachmentRequest) => Promise<RemoteResult<AgentTeamPutAttachmentResult>>
  getAttachment: (request: AgentTeamGetAttachmentRequest) => Promise<RemoteResult<AgentTeamGetAttachmentResult>>
  sendMessage: (request: AgentTeamSendMessageRequest) => Promise<RemoteResult<AgentTeamSendMessageResult>>
  reply: (request: AgentTeamReplyRequest) => Promise<RemoteResult<AgentTeamReplyResult | AgentTeamConfirmationRequired>>
  changeTask: (request: AgentTeamTaskRequest) => Promise<RemoteResult<AgentTeamTaskResult>>
  promoteThread: (request: AgentTeamPromoteThreadRequest) => Promise<RemoteResult<AgentTeamPromoteThreadResult>>
  resolveTaskRefs: (request: AgentTeamResolveTaskRefsRequest) => Promise<RemoteResult<AgentTeamResolveTaskRefsResult>>
  resolveThreadRefs: (request: AgentTeamResolveThreadRefsRequest) => Promise<RemoteResult<AgentTeamResolveThreadRefsResult>>
  /** Read-only reply-parent lookup; the Thread face fills its quote blocks from it. */
  resolveMessageRefs: (request: AgentTeamResolveMessageRefsRequest) => Promise<RemoteResult<AgentTeamResolveMessageRefsResult>>
  /** Whether this deployment offers quote-replies; every reply affordance gates on it. */
  replyCapabilities: TeamReplyCapabilitiesSource
  loadMembers: (request: AgentTeamMembersRequest) => Promise<RemoteResult<readonly AgentTeamClientMemberStatus[]>>
  /** Human direct-only Inbox slice; the Inbox page merges one call per visible Workspace. */
  loadInbox: (request: AgentTeamInboxRequest) => Promise<RemoteResult<AgentTeamInbox>>
  /**
   * The Human's to-do checklist: one Thread's detail, or the whole Workspace
   * with the Host's own per-Channel counts when a badge needs the aggregate.
   */
  loadHumanTodos: (request: AgentTeamHumanTodoListRequest) => Promise<RemoteResult<AgentTeamHumanTodoList>>
  /** Human-only to-do transitions: claim, answer, close. Each names a target state, so a repeat changes nothing. */
  changeHumanTodo: (request: AgentTeamHumanTodoActionRequest) => Promise<RemoteResult<AgentTeamHumanTodoResult>>
  /** Human-only Thread Attention observations; the Thread composer ranks the returned followers first. */
  threadObservations: (request: AgentTeamThreadObservationsRequest) => Promise<RemoteResult<AgentTeamThreadObservations>>
  /** Agent-card session jump, shared by every slot; message member chips reuse it. */
  openMemberSession: (sessionId: AgentTeamClientMemberStatus['member']['sessionId'], reportFailure?: (message: string) => void) => void
}

export type TeamSettingsProps = PropsRuntime<'sidebar.settings'> & PropsLocale<'team'> & {
  loadMemberGroups: () => Promise<readonly TeamMemberGroup[]>
  /** The shared Member face map, so the roster draws each Member's own picture
   * instead of the hue-and-initial fallback it drew before faces existed. */
  memberAvatars?: TeamMemberAvatars | undefined
}

export interface TeamMemberGroup {
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly members: readonly AgentTeamClientMemberStatus[]
}

export type TeamFooterProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'team'> & TeamNavigationActions & {
  navigation: TeamNavigationSource
}
