/**
 * The Channel layer of the session tree: one row per durable Channel
 * membership, its state, and — when it cannot be opened — a reason code.
 *
 * The reason code is the contract this file guards. A row that cannot be
 * opened must never be silent, and a code the Client cannot explain must land
 * on the generic one rather than leaking the Host's English `detail`, which
 * names session ids and internal vocabulary. Both halves have a case because
 * either one alone can pass while the other is broken: the known-code case
 * proves the mapping exists, the unknown-code case proves the fallback exists,
 * and neither proves the other.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { agentTeamHumanActor } from '../src/ledger.ts'
import { channelMemberScopeKey } from '../src/member-scope.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { AgentTeamChannelRef, AgentTeamChannelRowReason, AgentTeamMemberId, AgentTeamOperation, AgentTeamRequestId } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const cwd = process.cwd()
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
let channelCounter = 0
function nextChannelName(): string {
  channelCounter += 1
  return `tree-${channelCounter}`
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

type AgentTeamHarnessContext = Awaited<ReturnType<typeof harness>>['ctx']

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

async function newChannelFor(ctx: AgentTeamHarnessContext, name: string): Promise<AgentTeamChannelRef> {
  const created = await ctx.agentTeam.createChannel({
    requestId: requestId(`create-${name}`), workspaceId: alpha, name, description: '',
  })
  return created.channel.channelRef
}

/**
 * A Member joined to a Channel with no originating operation recorded: the
 * un-attributable shape. Its membership is written straight into the
 * projection because no request path can produce it any more, and it is the
 * shape that must surface as `origin-unrecorded` rather than vanish.
 */
async function joinedWithoutOrigin(ctx: Context, channelRef: AgentTeamChannelRef, handle: string): Promise<AgentTeamMemberId> {
  const memberId = `member:${handle}` as AgentTeamMemberId
  const ledger = ctx.agentTeam['ledger']!
  await ledger.addMember({
    requestId: requestId(`add-${handle}`), workspaceId: alpha, handle, description: 'Peer', presetId: 'team-member',
    channelRefs: [], actor: agentTeamHumanActor(),
    member: {
      memberId, sessionId: SessionId(`session:${handle}`), workspaceId: alpha, handle, description: 'Peer',
      presetId: 'team-member', privateMemoryPath: `/tmp/${handle}`, state: 'enabled' as const,
    },
  })
  const memberships = ledger['state'].memberships
  const members = memberships.get(channelRef) ?? new Set<AgentTeamMemberId>()
  members.add(memberId)
  memberships.set(channelRef, members)
  return memberId
}

function rowsOf(ctx: AgentTeamHarnessContext, memberId: AgentTeamMemberId) {
  return ctx.agentTeam.membersForClient({ workspaceId: alpha }).find(row => row.member.memberId === memberId)?.channels ?? []
}

/**
 * A Member who takes part in the Channel only through one of its Threads: a
 * Workspace participant named by the Human in a Channel message. Nothing along
 * this path records a membership, which is exactly the shape the tree used to
 * drop while the Channel page's own member count included it.
 */
async function participantThroughThreads(ctx: AgentTeamHarnessContext, channelRef: AgentTeamChannelRef, handle: string): Promise<AgentTeamMemberId> {
  const memberId = `member:${handle}` as AgentTeamMemberId
  const ledger = ctx.agentTeam['ledger']!
  await ledger.addMember({
    requestId: requestId(`add-${handle}`), workspaceId: alpha, handle, description: 'Peer', presetId: 'team-member',
    channelRefs: [], actor: agentTeamHumanActor(),
    member: {
      memberId, sessionId: SessionId(`session:${handle}`), workspaceId: alpha, handle, description: 'Peer',
      presetId: 'team-member', privateMemoryPath: `/tmp/${handle}`, state: 'enabled' as const,
    },
  })
  await ledger.sendMessage({
    requestId: requestId(`mention-${handle}`), workspaceId: alpha, channelRef, actor: agentTeamHumanActor(),
    body: `@${handle}, please take a look`,
  })
  return memberId
}

/**
 * The repair a backfill performs: enrol the Member in the Channel the way any
 * other enrolment is recorded, so the binding has a Human act to be credited to.
 *
 * Written as the ordinary enrolment rather than as a second kind of grant on
 * purpose — a repair that invented its own record shape would leave the tree
 * reading two definitions of "in this Channel".
 */
async function backfillParticipation(ctx: AgentTeamHarnessContext, channelRef: AgentTeamChannelRef, memberId: AgentTeamMemberId): Promise<void> {
  await ctx.agentTeam['ledger']!.joinChannel({
    requestId: requestId(`backfill-${memberId}`), workspaceId: alpha, channelRef, memberId,
    actor: agentTeamHumanActor(),
  })
}

describe('Channel rows in the Member session tree', () => {
  it('reports an un-attributable Channel as unopenable with the origin-unrecorded reason', async () => {
    const { ctx } = await harness()
    const channelRef = await newChannelFor(ctx, nextChannelName())
    const memberId = await joinedWithoutOrigin(ctx, channelRef, 'originless')

    await ctx.agentTeam['reconcileChannelWorkDomains'](ctx.agentTeam['ledger']!)

    const rows = rowsOf(ctx, memberId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.channelRef).toBe(channelRef)
    expect(rows[0]!.state).toBe('unopenable')
    // The code, not a sentence: the Client owns the wording. Pinned to the
    // specific code, because a generic "has some reason" assertion stays green
    // when this mapping is deleted — the row would fall back to `unknown`.
    expect(rows[0]!.reason).toBe('origin-unrecorded' satisfies AgentTeamChannelRowReason)
    // The Host's English detail never rides on the row; it stays on the Member
    // diagnostic where the risk surface renders it.
    expect(JSON.stringify(rows[0]!)).not.toContain('record of when it joined')
  })

  it('keeps a reason code this Client cannot explain off the row and on the generic sentence', async () => {
    const { ctx } = await harness()
    const channelRef = await newChannelFor(ctx, nextChannelName())
    const memberId = await joinedWithoutOrigin(ctx, channelRef, 'newcode')

    // A Host newer than this Client sends a code the projection was not taught.
    const original = ctx.agentTeam['channelRowReason']
    ctx.agentTeam['channelRowReason'] = function (this: unknown, ...args: Parameters<typeof original>) {
      const known = original.apply(this, args)
      return (known === undefined ? undefined : 'a-code-from-a-newer-host') as AgentTeamChannelRowReason
    }

    const rows = rowsOf(ctx, memberId)
    ctx.agentTeam['channelRowReason'] = original

    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('unopenable')
    // An unrecognised code must still leave the row explainable; this is what
    // the Client's generic sentence keys off.
    expect(rows[0]!.reason).toBe('a-code-from-a-newer-host')
  })

  it('explains every unopenable row, not just one of them', async () => {
    const { ctx } = await harness()
    // Three Channels the Member joined with no originating operation: the
    // `unopenable` population is the whole set, so "some row has a reason"
    // cannot stand in for "every row has one".
    const channelRefs = [await newChannelFor(ctx, nextChannelName()), await newChannelFor(ctx, nextChannelName()), await newChannelFor(ctx, nextChannelName())]
    const memberId = await joinedWithoutOrigin(ctx, channelRefs[0]!, 'multi')
    const memberships = ctx.agentTeam['ledger']!['state'].memberships
    for (const channelRef of channelRefs.slice(1)) {
      const members = memberships.get(channelRef) ?? new Set<AgentTeamMemberId>()
      members.add(memberId)
      memberships.set(channelRef, members)
    }

    await ctx.agentTeam['reconcileChannelWorkDomains'](ctx.agentTeam['ledger']!)

    const rows = rowsOf(ctx, memberId)
    const unopenable = rows.filter(row => row.state === 'unopenable')
    // The population is asserted before it is measured: `every` is true on an
    // empty array, so a selector or fixture that stopped producing failure rows
    // would otherwise pass while proving nothing.
    expect(unopenable).toHaveLength(channelRefs.length)
    for (const row of unopenable) {
      expect(row.reason, `row ${row.channelRef} must carry a reason code`).toBeDefined()
    }
  })

  it('opens a Session for a Member another Member named, not only for one the Human named', async () => {
    const { ctx } = await harness()
    const channelRef = await newChannelFor(ctx, nextChannelName())
    // The sender is an ordinary Channel Member; the named one is not in the
    // Channel at all, so the sender's Message is what enrols them. Only the
    // Human authorizes a Channel, so the sender is not the approver here.
    const senderId = await participantThroughThreads(ctx, channelRef, 'sender')
    const namedId = 'member:named' as AgentTeamMemberId
    await ctx.agentTeam['ledger']!.addMember({
      requestId: requestId('add-named'), workspaceId: alpha, handle: 'named', description: 'Peer', presetId: 'team-member',
      channelRefs: [], actor: agentTeamHumanActor(),
      member: {
        memberId: namedId, sessionId: SessionId('session:named'), workspaceId: alpha, handle: 'named', description: 'Peer',
        presetId: 'team-member', privateMemoryPath: '/tmp/named', state: 'enabled' as const,
      },
    })
    expect(ctx.agentTeam['ledger']!.memberInChannel(channelRef, namedId), 'not a Member until named').toBe(false)

    await ctx.agentTeam['ledger']!.sendMessage({
      requestId: requestId('member-names-member'), workspaceId: alpha, channelRef,
      actor: { kind: 'member', memberId: senderId, handle: 'sender' } as AgentTeamOperation['actor'],
      body: '@named, please take a look',
    })

    // The enrolment itself is a Member act, so the binding has to trace the
    // Message back to the Human whose membership the sender rests on. Asserting
    // only `memberInChannel` would pass while the Session stayed unopenable,
    // which is exactly the gap this case exists to close.
    await ctx.agentTeam['reconcileChannelWorkDomains'](ctx.agentTeam['ledger']!)
    const binding = ctx.agentTeam['ledger']!.memberScopeSessionFor(namedId, channelMemberScopeKey(channelRef))
    expect(binding, 'a Member-named Member must still get a Channel Session').toBeDefined()
    expect(rowsOf(ctx, namedId).find(row => row.channelRef === channelRef)?.state,
      'the row opens rather than reporting an unattributed origin').not.toBe('unopenable')
  })

  it('gives a repaired Channel a Session, so the row the Channel page counts is the row the tree can open', async () => {
    const { ctx } = await harness()
    const channelRef = await newChannelFor(ctx, nextChannelName())
    const memberId = await joinedWithoutOrigin(ctx, channelRef, 'unrepaired')

    // The Channel page counts this Member through the Thread derivation the
    // tree also reads, so the two agree even before the repair.
    const counted = ctx.agentTeam.view({ workspaceId: alpha }).members
      .filter(entry => entry.memberId === memberId)
      .map(entry => entry.channelRef)
    expect(counted).toEqual([channelRef])

    // A participation with no Human act behind it has nothing to attribute a
    // binding to, so the row must stay unopenable rather than open under a
    // guessed operator. This half asserts the "no fabricated actor" rule.
    await ctx.agentTeam['reconcileChannelWorkDomains'](ctx.agentTeam['ledger']!)
    expect(ctx.agentTeam['ledger']!.memberScopeSessionFor(memberId, channelMemberScopeKey(channelRef))).toBeUndefined()

    // The repair is what makes the Channel openable: enrolling the Member gives
    // the binding an author, and the reconciliation pass then opens it.
    await backfillParticipation(ctx, channelRef, memberId)
    await ctx.agentTeam['reconcileChannelWorkDomains'](ctx.agentTeam['ledger']!)

    const binding = ctx.agentTeam['ledger']!.memberScopeSessionFor(memberId, channelMemberScopeKey(channelRef))
    expect(binding, 'the repaired participation must carry a Session').toBeDefined()
    const rows = rowsOf(ctx, memberId)
    expect(rows.map(row => row.channelRef)).toEqual([channelRef])
    expect(rows[0]!.state).not.toBe('unopenable')
    expect(rows[0]!.reason, 'a repaired row is openable, so it carries no failure code').toBeUndefined()
    expect(rows[0]!.sessionId).toBe(binding!.sessionId)
  })

  it('derives channel row activity and rolls it up to member presence with warning > running > normal priority', async () => {
    const { ctx } = await harness()
    const chNormal = await newChannelFor(ctx, nextChannelName())
    const chRunning = await newChannelFor(ctx, nextChannelName())
    const chWarning = await newChannelFor(ctx, nextChannelName())
    const memberId = 'member:rollup' as AgentTeamMemberId
    const defaultSessionId = SessionId('session:rollup')
    const ledger = ctx.agentTeam['ledger']!

    await ledger.addMember({
      requestId: requestId('add-rollup'), workspaceId: alpha, handle: 'rollup', description: 'Peer', presetId: 'team-member',
      channelRefs: [chNormal, chRunning], actor: agentTeamHumanActor(),
      member: {
        memberId, sessionId: defaultSessionId, workspaceId: alpha, handle: 'rollup', description: 'Peer',
        presetId: 'team-member', privateMemoryPath: '/tmp/rollup', state: 'enabled' as const,
      },
    })
    await ctx.agentTeam['reconcileChannelWorkDomains'](ledger)

    const fakeHandle = (sessionId: SessionId, status: 'idle' | 'running' = 'idle') => ({
      agent: { id: sessionId, status, ctx, session: { id: sessionId } },
      dispose: async () => {},
    })
    ctx.agentTeam['registerHandle'](memberId, 'default' as never, fakeHandle(defaultSessionId, 'idle') as never)
    ctx.agentTeam['memberRuntime'].recordAppliedCapabilities(memberId, undefined)

    const bindNormal = ledger.memberScopeSessionFor(memberId, channelMemberScopeKey(chNormal))!
    const bindRunning = ledger.memberScopeSessionFor(memberId, channelMemberScopeKey(chRunning))!
    ctx.agentTeam['registerHandle'](memberId, channelMemberScopeKey(chNormal), fakeHandle(bindNormal.sessionId, 'idle') as never)
    ctx.agentTeam['registerHandle'](memberId, channelMemberScopeKey(chRunning), fakeHandle(bindRunning.sessionId, ' idle'.trim() as 'idle') as never)

    let clientRow = ctx.agentTeam.membersForClient({ workspaceId: alpha }).find(row => row.member.memberId === memberId)!
    expect(clientRow.channels.map(row => row.activity)).toEqual(['normal', 'normal'])
    expect(clientRow.presence).toBe('available')

    // Running channel session rolls member presence up to working.
    ctx.agentTeam['registerHandle'](memberId, channelMemberScopeKey(chRunning), fakeHandle(bindRunning.sessionId, 'running') as never)
    clientRow = ctx.agentTeam.membersForClient({ workspaceId: alpha }).find(row => row.member.memberId === memberId)!
    expect(clientRow.channels.find(row => row.channelRef === chRunning)?.activity).toBe('running')
    expect(clientRow.presence).toBe('working')

    // Warning channel session outranks running and rolls member presence up to error.
    const memberships = ledger['state'].memberships
    memberships.set(chWarning, new Set([memberId]))
    clientRow = ctx.agentTeam.membersForClient({ workspaceId: alpha }).find(row => row.member.memberId === memberId)!
    expect(clientRow.channels.find(row => row.channelRef === chWarning)?.activity).toBe('warning')
    expect(clientRow.presence).toBe('error')
  })

  it('reports a Channel row as warning while its Session holds an unrecovered failure', async () => {
    const { ctx } = await harness()
    const ch = await newChannelFor(ctx, nextChannelName())
    const memberId = 'member:failing' as AgentTeamMemberId
    const ledger = ctx.agentTeam['ledger']!
    await ledger.addMember({
      requestId: requestId('add-failing'), workspaceId: alpha, handle: 'failing', description: 'Peer', presetId: 'team-member',
      channelRefs: [ch], actor: agentTeamHumanActor(),
      member: {
        memberId, sessionId: SessionId('session:failing'), workspaceId: alpha, handle: 'failing', description: 'Peer',
        presetId: 'team-member', privateMemoryPath: '/tmp/failing', state: 'enabled' as const,
      },
    })
    await ctx.agentTeam['reconcileChannelWorkDomains'](ledger)
    const binding = ledger.memberScopeSessionFor(memberId, channelMemberScopeKey(ch))!
    ctx.agentTeam['registerHandle'](memberId, channelMemberScopeKey(ch), {
      agent: { id: binding.sessionId, status: 'idle', ctx, session: { id: binding.sessionId } },
      dispose: async () => {},
    } as never)

    const activityOf = () => ctx.agentTeam.membersForClient({ workspaceId: alpha })
      .find(row => row.member.memberId === memberId)!.channels[0]!.activity
    expect(activityOf(), 'a live Session with no failure is normal').toBe('normal')

    ctx.agentTeam['sessionFailures'].add(binding.sessionId)
    expect(activityOf(), 'the failure the row shows is the Session\'s own, not the Member\'s').toBe('warning')
  })
})
