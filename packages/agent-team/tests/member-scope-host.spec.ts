/**
 * Work domains at the Host seam: which domain's declarations a Member's Message
 * claims, and the one entry a discussion's domain refuses.
 *
 * The observable surface is the Message itself. `commitMessageAs` hands the
 * claim to the ledger as `resolvedArtifacts`, so "which domain's files did this
 * Message carry" is readable from the committed result without reaching into
 * Host state — the same surface a reader of the Thread sees.
 */
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { agentTeamHumanActor } from '../src/ledger.ts'
import { DEFAULT_MEMBER_SCOPE_KEY, channelMemberScopeKey, memberScopeSession } from '../src/member-scope.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {
  AgentTeamChannelRef, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamMemberScopeKey,
  AgentTeamMessageArtifact, AgentTeamRequestId, AgentTeamThreadRef,
} from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const cwd = process.cwd()
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** One Host carrying every service the Message commit path reads, projections included. */
async function harness(): Promise<{ readonly ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === alpha ? { id, path: cwd, attachSession: async () => {}, archiveSession: async () => {} } : undefined,
    list: () => [{ id: alpha, path: cwd }],
    archiveSession: async () => {},
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') }, composedPreset: () => ({}) })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [], stat: async () => undefined })
  await ctx.plugin(agentTeamInvariant)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx }
}

interface TestMember {
  readonly memberId: AgentTeamMemberId
  readonly sessionId: SessionId
  readonly actor: AgentTeamMemberActor
}

/** One enabled Member in the channel, added through the live ledger so the Host carries it. */
async function addMember(ctx: Context, channelRef: AgentTeamChannelRef, handle: string): Promise<TestMember> {
  const memberId = `member:${handle}` as AgentTeamMemberId
  const sessionId = SessionId(`session:${handle}`)
  await ctx.agentTeam['ledger']!.addMember({
    requestId: requestId(`ledger-member-${handle}`), workspaceId: alpha, handle, description: 'Peer', presetId: 'team-member',
    channelRefs: [channelRef], actor: agentTeamHumanActor(),
    member: {
      memberId, sessionId, workspaceId: alpha, handle, description: 'Peer',
      presetId: 'team-member', privateMemoryPath: `/tmp/${handle}`, state: 'enabled' as const,
    },
  })
  return { memberId, sessionId, actor: Object.freeze({ kind: 'member', memberId, handle }) }
}

/**
 * One Session that declared a file with `present` in its first turn, folded by
 * the same unit the Host registers. The declaration is the only input the claim
 * reads, so a domain is distinguishable by what it declared.
 */
function declaringSession(ctx: Context, sessionId: SessionId, path: string): Session {
  const session = ctx.sessions.create(sessionId, { meta: { cwd } })
  session.append('turn/start', { turn: 1 })
  session.append('deliverables/presented', { turn: 1, callId: ToolCallId(`call:${sessionId}`), files: [{ path, description: `the ${path}` }] })
  return session
}

/** The live generation of one Session: only the surface the claim and the rollover gate read. */
function liveAgent(session: Session): Agent {
  return {
    id: session.id,
    session,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [], remove: () => {} },
    steer: () => {},
    followup: () => {},
  } as unknown as Agent
}

/** Register one Member's live generations the way activation does, one entry per work domain. */
function registerDomains(ctx: Context, memberId: AgentTeamMemberId, entries: readonly (readonly [AgentTeamMemberScopeKey, Agent])[]): void {
  const bucket = new Map(entries.map(([scopeKey, agent]) => [scopeKey, { agent, dispose: async () => {} } as unknown as AgentHandle]))
  ctx.agentTeam['handles'].set(memberId, bucket)
}

const artifact = (sessionId: SessionId, path: string, description: string): AgentTeamMessageArtifact => ({
  sessionId: sessionId as AgentTeamMessageArtifact['sessionId'], path, description,
})

/** A Channel plus one open Thread: the discussion whose domain the Member can act in. */
async function channelWithThread(ctx: Context): Promise<{ readonly channelRef: AgentTeamChannelRef; readonly threadRef: AgentTeamThreadRef }> {
  const channel = await ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
  const channelRef = channel.channel.channelRef
  const opened = await ctx.agentTeam.sendMessage({ asTask: false, requestId: requestId('opening'), workspaceId: alpha, channelRef, body: 'Kickoff' })
  if (opened.kind !== 'committed') throw new Error(`expected an opening Message, received ${opened.kind}`)
  return { channelRef, threadRef: opened.thread.threadRef }
}

describe('one Message, one work domain', () => {
  it('claims the acting domain\'s declarations, and the default domain\'s when no Session is named', async () => {
    const { ctx } = await harness()
    const { channelRef, threadRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'reader')
    const scopeKey = channelMemberScopeKey(channelRef)
    // The discussion is a real domain: bound in the ledger for its first delivery.
    const discussionSessionId = SessionId('session:reader-discussion')
    await ctx.agentTeam['ledger']!.bindMemberScopeSession({
      requestId: requestId('bind-discussion'), workspaceId: alpha, workspaceRoot: cwd, memberId: member.memberId,
      binding: memberScopeSession(scopeKey, discussionSessionId), actor: agentTeamHumanActor(),
    })

    // Two domains, each with its own declaration: which one the Message carries
    // is the whole reading.
    const ownSession = declaringSession(ctx, member.sessionId, 'docs/own.md')
    const discussionSession = declaringSession(ctx, discussionSessionId, 'docs/discussion.md')
    const ownAgent = liveAgent(ownSession)
    const discussionAgent = liveAgent(discussionSession)
    registerDomains(ctx, member.memberId, [[DEFAULT_MEMBER_SCOPE_KEY, ownAgent], [scopeKey, discussionAgent]])

    // Sent from the discussion: the Message carries the discussion's file, never
    // the Member's own domain's file.
    const fromDiscussion = await ctx.agentTeam.sendMessageForAgent(discussionAgent, {
      requestId: requestId('discussion-message'), workspaceId: alpha, channelRef, body: 'The discussion report',
    })
    if (fromDiscussion.kind !== 'committed') throw new Error(`expected a committed Message, received ${fromDiscussion.kind}`)
    expect(fromDiscussion.message.artifacts).toEqual([artifact(discussionSessionId, `${cwd}/docs/discussion.md`, 'the docs/discussion.md')])

    // No Session named: the Member's own domain answers, exactly as it did when
    // a Member held one Session.
    const unnamed = await ctx.agentTeam['sendMessageAs'](member.actor, {
      requestId: requestId('unnamed-message'), workspaceId: alpha, channelRef, body: 'No Session named',
    })
    if (unnamed.kind !== 'committed') throw new Error(`expected a committed Message, received ${unnamed.kind}`)
    expect(unnamed.message.artifacts).toEqual([artifact(member.sessionId, `${cwd}/docs/own.md`, 'the docs/own.md')])

    // Each domain spent its own declaration: neither Message consumed the other's.
    expect(ctx.agentTeam['claimedDeliveries'].get(member.sessionId)?.callIds.has(`call:${member.sessionId}`)).toBe(true)
    expect(ctx.agentTeam['claimedDeliveries'].get(discussionSessionId)?.callIds.has(`call:${discussionSessionId}`)).toBe(true)
  })

  it('never adopts a named Session that belongs to another Member', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const sender = await addMember(ctx, channelRef, 'sender')
    const other = await addMember(ctx, channelRef, 'other')
    const senderSession = declaringSession(ctx, sender.sessionId, 'docs/sender.md')
    const otherSession = declaringSession(ctx, other.sessionId, 'docs/other.md')
    registerDomains(ctx, sender.memberId, [[DEFAULT_MEMBER_SCOPE_KEY, liveAgent(senderSession)]])
    registerDomains(ctx, other.memberId, [[DEFAULT_MEMBER_SCOPE_KEY, liveAgent(otherSession)]])

    // A Session this Member does not run is not adopted: the claim takes the same
    // fallback an unnamed Session takes, so another Member's files can never be
    // handed over as this author's.
    const sent = await ctx.agentTeam['sendMessageAs'](sender.actor, {
      requestId: requestId('foreign-session'), workspaceId: alpha, channelRef, body: 'Not my Session',
    }, other.sessionId)
    if (sent.kind !== 'committed') throw new Error(`expected a committed Message, received ${sent.kind}`)
    expect(sent.message.artifacts).toEqual([artifact(sender.sessionId, `${cwd}/docs/sender.md`, 'the docs/sender.md')])
    expect(ctx.agentTeam['claimedDeliveries'].get(other.sessionId), 'the other Member\'s declaration is untouched').toBeUndefined()
  })
})

describe('work-domain activation paths', () => {
  it('returns the exact default binding without synthesizing a directory snapshot', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'default-domain')
    const agent = liveAgent(ctx.sessions.create(member.sessionId, { meta: { cwd } }))
    registerDomains(ctx, member.memberId, [[DEFAULT_MEMBER_SCOPE_KEY, agent]])

    expect(ctx.agentTeam.workDomainForAgent(agent)).toEqual({
      scopeKey: DEFAULT_MEMBER_SCOPE_KEY, scopeKind: 'default', sessionId: member.sessionId,
    })
  })

  it('rejects a missing configured directory without marking the Member unavailable', async () => {
    const { ctx } = await harness()
    const { channelRef, threadRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'path-check')
    const missingDirectory = `${cwd}/.missing-work-domain-${randomUUID()}`
    await ctx.agentTeam.updateChannelWorkingDirectories({ requestId: requestId('missing-dir-config'),
      workspaceId: alpha, channelRef, workingDirectories: [cwd, missingDirectory] })
    expect(ctx.agentTeam.channelWorkingDirectorySettings({ workspaceId: alpha, channelRef }).defaultWorkingDirectories)
      .toEqual([cwd, missingDirectory])
    const bound = await ctx.agentTeam['ledger']!.bindMemberScopeSession({ requestId: requestId('missing-dir-bind'), actor: agentTeamHumanActor(),
      workspaceId: alpha, workspaceRoot: cwd, memberId: member.memberId,
      binding: memberScopeSession(channelMemberScopeKey(channelRef), SessionId('session:path-check-domain')) })
    if (!bound.committed) throw new Error('domain binding unexpectedly resolved instead of committing')

    const defaultSession = ctx.sessions.create(member.sessionId, { meta: { cwd } })
    registerDomains(ctx, member.memberId, [[DEFAULT_MEMBER_SCOPE_KEY, liveAgent(defaultSession)]])
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.agentTeam['activateMember'](ctx.agentTeam['ledger']!.getMember(member.memberId)!, bound.value.binding)

    expect(warning.mock.calls.some(([message]) => String(message).includes(missingDirectory))).toBe(true)
    expect(ctx.agentTeam['memberStatus'](ctx.agentTeam['ledger']!.getMember(member.memberId)!).availability).toBe('active')
    warning.mockRestore()
  })

  it('uses the first snapshotted directory as the Session cwd', async () => {
    const { ctx } = await harness()
    const { channelRef, threadRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'cwd-check')
    const domainRoot = dirname(cwd)
    await ctx.agentTeam.updateChannelWorkingDirectories({ requestId: requestId('cwd-dir-config'),
      workspaceId: alpha, channelRef, workingDirectories: [domainRoot, cwd] })
    const bound = await ctx.agentTeam['ledger']!.bindMemberScopeSession({ requestId: requestId('cwd-dir-bind'), actor: agentTeamHumanActor(),
      workspaceId: alpha, workspaceRoot: cwd, memberId: member.memberId,
      binding: memberScopeSession(channelMemberScopeKey(channelRef), SessionId('session:cwd-check-domain')) })
    if (!bound.committed) throw new Error('domain binding unexpectedly resolved instead of committing')

    ctx.agentTeam['memberRuntime']['initializePrivateMemory'] = async () => {}
    let activatedCwd: string | undefined
    let createdAgent: Agent | undefined
    const agents = ctx.agents as unknown as {
      create: (request: { readonly sessionId: SessionId; readonly meta: { readonly cwd: string } }) => Promise<AgentHandle>
    }
    agents.create = async request => {
      activatedCwd = request.meta.cwd
      const session = ctx.sessions.create(request.sessionId, { meta: request.meta })
      const agent = Object.assign(liveAgent(session), { ctx: new Context() }) as Agent
      createdAgent = agent
      return { agent, dispose: async () => {} } as AgentHandle
    }
    await ctx.agentTeam['activateMember'](ctx.agentTeam['ledger']!.getMember(member.memberId)!, bound.value.binding,
      undefined, undefined, undefined, { deferNotify: true })

    expect(activatedCwd).toBe(domainRoot)
    expect(ctx.agentTeam.workDomainForAgent(createdAgent!)?.workingDirectories).toEqual([domainRoot, cwd])
  })
})

describe('the rollover entry by work-domain kind', () => {
  // A Channel domain is a long-lived context shared by every discussion in the
  // Channel, so it renews exactly like the Member default. Gating it off would
  // leave its container growing with only in-place reduction as relief.
  it('admits a Channel domain instead of refusing it', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'reader')
    const scopeKey = channelMemberScopeKey(channelRef)
    const ownSession = ctx.sessions.create(member.sessionId, { meta: { cwd } })
    const domainSession = ctx.sessions.create(SessionId('session:reader-domain'), { meta: { cwd } })
    const ownAgent = liveAgent(ownSession)
    const domainAgent = liveAgent(domainSession)
    registerDomains(ctx, member.memberId, [[DEFAULT_MEMBER_SCOPE_KEY, ownAgent], [scopeKey, domainAgent]])

    // The domain-kind refusal must no longer fire for a Channel domain. The
    // guards unrelated to the kind stay in force, so a fabricated agent is
    // refused for running outside its own turn — which is exactly the proof
    // wanted here: rejection reaches a later, kind-independent guard.
    await expect(ctx.agentTeam.requestNewContext(domainAgent, { memberId: member.memberId }))
      .rejects.not.toThrow(/not supported in work domain/)
  })

  it('classifies the same domains as renewable for the pressure judge', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'reader')
    const scopeKey = channelMemberScopeKey(channelRef)
    const ownSession = ctx.sessions.create(member.sessionId, { meta: { cwd } })
    const domainSession = ctx.sessions.create(SessionId('session:judged-domain'), { meta: { cwd } })
    const ownAgent = liveAgent(ownSession)
    const domainAgent = liveAgent(domainSession)
    registerDomains(ctx, member.memberId, [[DEFAULT_MEMBER_SCOPE_KEY, ownAgent], [scopeKey, domainAgent]])

    // The judge and the gate must answer identically: a domain offered a
    // remedy the gate refuses would stall instead of relieving, and one the
    // gate allows but the judge skips would grow without reduction.
    const renewable = (agent: Parameters<typeof ctx.agentTeam.requestNewContext>[0]) => ctx.agentTeam['renewsContextForAgent'](agent)
    expect(renewable(ownAgent)).toBe(true)
    expect(renewable(domainAgent)).toBe(true)
  })

  it('still refuses a Session that is not a live Member work domain', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'reader')
    const stranger = liveAgent(ctx.sessions.create(SessionId('session:not-a-domain'), { meta: { cwd } }))

    // Not registered as any domain, so the entry cannot classify it as
    // renewable; it must fail rather than fall through to a swap.
    await expect(ctx.agentTeam.requestNewContext(stranger, { memberId: member.memberId }))
      .rejects.toThrow()
  })
})
