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
  readonly channelSessionId: SessionId
  readonly channelScopeKey: AgentTeamMemberScopeKey
  readonly actor: AgentTeamMemberActor
}

/** One enabled Member with one explicitly bound Channel Session. */
async function addMember(ctx: Context, channelRef: AgentTeamChannelRef, handle: string, options: { readonly bindDomain?: boolean } = {}): Promise<TestMember> {
  const memberId = `member:${handle}` as AgentTeamMemberId
  const channelSessionId = SessionId(`session:${handle}`)
  const channelScopeKey = channelMemberScopeKey(channelRef)
  await ctx.agentTeam['ledger']!.addMember({
    requestId: requestId(`ledger-member-${handle}`), workspaceId: alpha, handle, description: 'Peer', presetId: 'team-member',
    channelRefs: [channelRef], actor: agentTeamHumanActor(),
    member: {
      memberId, workspaceId: alpha, handle, description: 'Peer',
      presetId: 'team-member', privateMemoryPath: `/tmp/${handle}`, state: 'enabled' as const,
    },
  })
  if (options.bindDomain !== false) {
    await ctx.agentTeam['ledger']!.bindMemberScopeSession({
      requestId: requestId(`bind-channel-${handle}`), workspaceId: alpha, workspaceRoot: cwd, memberId,
      binding: memberScopeSession(channelScopeKey, channelSessionId), actor: agentTeamHumanActor(),
    })
  }
  return { memberId, channelSessionId, channelScopeKey, actor: Object.freeze({ kind: 'member', memberId, handle }) }
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
  it('claims declarations only from the acting Channel Session', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'reader')
    const session = declaringSession(ctx, member.channelSessionId, 'docs/channel.md')
    const agent = liveAgent(session)
    registerDomains(ctx, member.memberId, [[member.channelScopeKey, agent]])

    const sent = await ctx.agentTeam.sendMessageForAgent(agent, {
      requestId: requestId('channel-message'), workspaceId: alpha, channelRef, body: 'The Channel report',
    })
    if (sent.kind !== 'committed') throw new Error(`expected a committed Message, received ${sent.kind}`)
    expect(sent.message.artifacts).toEqual([artifact(member.channelSessionId, `${cwd}/docs/channel.md`, 'the docs/channel.md')])

    // A Session-less caller cannot fall back to a Member-wide default Session.
    const unnamed = await ctx.agentTeam['sendMessageAs'](member.actor, {
      requestId: requestId('unnamed-message'), workspaceId: alpha, channelRef, body: 'No Session named',
    })
    if (unnamed.kind !== 'committed') throw new Error(`expected a committed Message, received ${unnamed.kind}`)
    expect(unnamed.message.artifacts).toBeUndefined()
    expect(ctx.agentTeam['claimedDeliveries'].get(member.channelSessionId)?.callIds.has(`call:${member.channelSessionId}`)).toBe(true)
  })

  it('never adopts a named Session that belongs to another Member', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const sender = await addMember(ctx, channelRef, 'sender')
    const other = await addMember(ctx, channelRef, 'other')
    const senderAgent = liveAgent(declaringSession(ctx, sender.channelSessionId, 'docs/sender.md'))
    const otherAgent = liveAgent(declaringSession(ctx, other.channelSessionId, 'docs/other.md'))
    registerDomains(ctx, sender.memberId, [[sender.channelScopeKey, senderAgent]])
    registerDomains(ctx, other.memberId, [[other.channelScopeKey, otherAgent]])

    const sent = await ctx.agentTeam['sendMessageAs'](sender.actor, {
      requestId: requestId('foreign-session'), workspaceId: alpha, channelRef, body: 'Not my Session',
    }, other.channelSessionId)
    if (sent.kind !== 'committed') throw new Error(`expected a committed Message, received ${sent.kind}`)
    expect(sent.message.artifacts).toBeUndefined()
    expect(ctx.agentTeam['claimedDeliveries'].get(other.channelSessionId), 'the other Member\'s declaration is untouched').toBeUndefined()
    expect(ctx.agentTeam['claimedDeliveries'].get(sender.channelSessionId), 'the sender did not claim without its own acting Session').toBeUndefined()
  })
})

describe('work-domain activation paths', () => {
  it('returns the exact Channel binding without a Member default Session', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'channel-domain')
    const agent = liveAgent(ctx.sessions.create(member.channelSessionId, { meta: { cwd } }))
    registerDomains(ctx, member.memberId, [[member.channelScopeKey, agent]])

    expect(ctx.agentTeam.workDomainForAgent(agent)).toMatchObject({
      scopeKey: member.channelScopeKey, scopeKind: 'channel', scopeRef: channelRef,
      sessionId: member.channelSessionId, workingDirectories: [cwd],
    })
    expect(ctx.agentTeam['ledger']!.getMember(member.memberId)).not.toHaveProperty('sessionId')
    expect(ctx.agentTeam['handles'].get(member.memberId)?.has(DEFAULT_MEMBER_SCOPE_KEY)).toBe(false)
  })

  it('rejects a missing configured directory without hiding another active Channel Session', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'path-check', { bindDomain: false })
    const missingDirectory = `${cwd}/.missing-work-domain-${randomUUID()}`
    await ctx.agentTeam.updateChannelWorkingDirectories({ requestId: requestId('missing-dir-config'),
      workspaceId: alpha, channelRef, workingDirectories: [cwd, missingDirectory] })
    expect(ctx.agentTeam.channelWorkingDirectorySettings({ workspaceId: alpha, channelRef }).defaultWorkingDirectories)
      .toEqual([cwd, missingDirectory])
    const bound = await ctx.agentTeam['ledger']!.bindMemberScopeSession({ requestId: requestId('missing-dir-bind'), actor: agentTeamHumanActor(),
      workspaceId: alpha, workspaceRoot: cwd, memberId: member.memberId,
      binding: memberScopeSession(member.channelScopeKey, member.channelSessionId) })
    if (!bound.committed) throw new Error('domain binding unexpectedly resolved instead of committing')

    const healthyChannel = await ctx.agentTeam.createChannel({ requestId: requestId('healthy-channel'), workspaceId: alpha,
      name: 'healthy', description: 'Active sibling domain' })
    await ctx.agentTeam['ledger']!.joinChannel({ requestId: requestId('healthy-member'), workspaceId: alpha,
      channelRef: healthyChannel.channel.channelRef, memberId: member.memberId, actor: agentTeamHumanActor() })
    const healthyScope = channelMemberScopeKey(healthyChannel.channel.channelRef)
    const healthySessionId = SessionId('session:path-check-healthy')
    const healthyBinding = await ctx.agentTeam['ledger']!.bindMemberScopeSession({ requestId: requestId('healthy-bind'), actor: agentTeamHumanActor(),
      workspaceId: alpha, workspaceRoot: cwd, memberId: member.memberId,
      binding: memberScopeSession(healthyScope, healthySessionId) })
    if (!healthyBinding.committed) throw new Error('healthy domain binding unexpectedly resolved instead of committing')
    registerDomains(ctx, member.memberId, [[healthyScope, liveAgent(ctx.sessions.create(healthySessionId, { meta: { cwd } }))]])

    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.agentTeam['activateMember'](ctx.agentTeam['ledger']!.getMember(member.memberId)!, bound.value.binding)

    expect(warning.mock.calls.some(([message]) => String(message).includes(missingDirectory))).toBe(true)
    expect(ctx.agentTeam['memberStatus'](ctx.agentTeam['ledger']!.getMember(member.memberId)!).availability).toBe('active')
    warning.mockRestore()
  })

  it('uses the first snapshotted directory as the Channel Session cwd', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'cwd-check', { bindDomain: false })
    const domainRoot = dirname(cwd)
    await ctx.agentTeam.updateChannelWorkingDirectories({ requestId: requestId('cwd-dir-config'),
      workspaceId: alpha, channelRef, workingDirectories: [domainRoot, cwd] })
    const bound = await ctx.agentTeam['ledger']!.bindMemberScopeSession({ requestId: requestId('cwd-dir-bind'), actor: agentTeamHumanActor(),
      workspaceId: alpha, workspaceRoot: cwd, memberId: member.memberId,
      binding: memberScopeSession(member.channelScopeKey, member.channelSessionId) })
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
  it('admits a Channel domain instead of refusing it', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'reader')
    const domainAgent = liveAgent(ctx.sessions.create(member.channelSessionId, { meta: { cwd } }))
    registerDomains(ctx, member.memberId, [[member.channelScopeKey, domainAgent]])

    // The domain-kind refusal must no longer fire; unrelated running-turn guards stay active.
    await expect(ctx.agentTeam.requestNewContext(domainAgent, { memberId: member.memberId }))
      .rejects.not.toThrow(/not supported in work domain/)
  })

  it('classifies the Channel Session as renewable for the pressure judge', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'reader')
    const domainAgent = liveAgent(ctx.sessions.create(member.channelSessionId, { meta: { cwd } }))
    registerDomains(ctx, member.memberId, [[member.channelScopeKey, domainAgent]])

    expect(ctx.agentTeam['renewsContextForAgent'](domainAgent)).toBe(true)
  })

  it('still refuses a Session that is not a live Member work domain', async () => {
    const { ctx } = await harness()
    const { channelRef } = await channelWithThread(ctx)
    const member = await addMember(ctx, channelRef, 'reader')
    const stranger = liveAgent(ctx.sessions.create(SessionId('session:not-a-domain'), { meta: { cwd } }))

    await expect(ctx.agentTeam.requestNewContext(stranger, { memberId: member.memberId }))
      .rejects.toThrow()
  })
})
