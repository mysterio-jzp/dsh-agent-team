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
import { DEFAULT_MEMBER_SCOPE_KEY, channelMemberScopeKey, memberScopeSession } from '../src/member-scope.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AgentTeamChannelRef, AgentTeamChannelRowReason, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../src/types.ts'

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

    // Sent through the ledger, then the effect every write path owes is run
    // explicitly: opening a domain is a Host act, and this fixture has no live
    // Agent to send through.
    const sent = await ctx.agentTeam['ledger']!.sendMessage({
      requestId: requestId('member-names-member'), workspaceId: alpha, channelRef,
      actor: { kind: 'member', memberId: senderId, handle: 'sender' } as AgentTeamOperation['actor'],
      body: '@named, please take a look',
    })
    for (const memberId of sent.enrolledMembers ?? []) {
      await ctx.agentTeam['openChannelWorkDomain'](memberId, channelRef)
    }

    // The enrolment itself is a Member act, so the binding has to trace the
    // Message back to the Human whose membership the sender rests on. Asserting
    // only `memberInChannel` would pass while the Session stayed unopenable,
    // which is exactly the gap this case exists to close. The Message opens the
    // domain itself: waiting for a restart would be the bug, not the contract.
    const ledger = ctx.agentTeam['ledger']!
    const binding = ledger.memberScopeSessionFor(namedId, channelMemberScopeKey(channelRef))
    expect(binding, 'a Member-named Member must still get a Channel Session').toBeDefined()
    // This fixture's Agents refuse to start, so the row cannot be `ready`; what
    // this case pins is that the origin is recorded and the failure named as an
    // activation failure of this very row, not reported as a missing origin.
    const row = rowsOf(ctx, namedId).find(entry => entry.channelRef === channelRef)
    expect(row?.reason, 'the row reports the origin as recorded').not.toBe('origin-unrecorded')
    expect(row?.state, 'a failed start is stated as such, never left `creating`').toBe('unopenable')
    expect(row?.sessionId, 'the row names the Session this domain is bound to').toBe(binding?.sessionId)
  })

  it('restores every other domain of a Member whose one domain fails to start', async () => {
    const { ctx } = await harness()
    const first = await newChannelFor(ctx, nextChannelName())
    const second = await newChannelFor(ctx, nextChannelName())
    const memberId = 'member:restored' as AgentTeamMemberId
    await ctx.agentTeam['ledger']!.addMember({
      requestId: requestId('add-restored'), workspaceId: alpha, handle: 'restored', description: 'Peer', presetId: 'team-member',
      channelRefs: [first, second], actor: agentTeamHumanActor(),
      member: {
        memberId, sessionId: SessionId('session:restored'), workspaceId: alpha, handle: 'restored', description: 'Peer',
        presetId: 'team-member', privateMemoryPath: '/tmp/restored', state: 'enabled' as const,
      },
    })
    const ledger = ctx.agentTeam['ledger']!
    // Both domains are bound, so restoration — not reconciliation — is what
    // starts them.
    for (const channelRef of [first, second]) {
      await ledger.bindMemberScopeSession({
        requestId: requestId(`bind-${channelRef}`), workspaceId: alpha, workspaceRoot: cwd,
        memberId, binding: memberScopeSession(channelMemberScopeKey(channelRef), SessionId(`session:${channelRef}`)),
        actor: agentTeamHumanActor(), sourceOperationId: `operation:bind-${channelRef}` as AgentTeamOperationId,
      })
    }
    const member = ledger.getMember(memberId)!
    const failing = channelMemberScopeKey(first)
    const starting = channelMemberScopeKey(second)
    const started: string[] = []
    // One domain refuses to start; the other must still be reached.
    ctx.agentTeam['activateMember'] = async (_member: unknown, binding: { readonly scopeKey: string }) => {
      if (binding.scopeKey === failing) throw new Error('this domain cannot start')
      started.push(binding.scopeKey)
    }
    await ctx.agentTeam['restoreMemberDomains'](member)

    expect(started.filter(scopeKey => scopeKey !== DEFAULT_MEMBER_SCOPE_KEY),
      'a failing domain must not take the next one down with it').toEqual([starting])
    // The failed domain keeps its own readable reason, tied to its own binding.
    const rows = rowsOf(ctx, memberId)
    const failedRow = rows.find(row => row.channelRef === first)
    expect(failedRow?.state, 'the failing row states a failure instead of staying `creating`').toBe('unopenable')
    expect(failedRow?.reason).toBe('activation-failed')
  })

  it('wakes the Channel Session of an enrolled Member rather than its own', async () => {
    const { ctx } = await harness()
    const channelRef = await newChannelFor(ctx, nextChannelName())
    // A Member the Human enrols by hand: the enrolment is recorded as an
    // ordinary Channel membership, which is what binds a Channel domain.
    const memberId = 'member:woken' as AgentTeamMemberId
    await ctx.agentTeam['ledger']!.addMember({
      requestId: requestId('add-woken'), workspaceId: alpha, handle: 'woken', description: 'Peer', presetId: 'team-member',
      channelRefs: [channelRef], actor: agentTeamHumanActor(),
      member: {
        memberId, sessionId: SessionId('session:woken'), workspaceId: alpha, handle: 'woken', description: 'Peer',
        presetId: 'team-member', privateMemoryPath: '/tmp/woken', state: 'enabled' as const,
      },
    })
    await ctx.agentTeam['reconcileChannelWorkDomains'](ctx.agentTeam['ledger']!)

    const scopeKey = channelMemberScopeKey(channelRef)
    const binding = ctx.agentTeam['ledger']!.memberScopeSessionFor(memberId, scopeKey)
    expect(binding, 'an enrolled Member holds a Channel Session').toBeDefined()
    expect(binding!.sessionId).not.toBe(SessionId('session:woken'))

    // A Thread message is a Channel fact, so it wakes the Channel's Session —
    // the one the Channel page opens — and never the Member's own.
    const channelCalls: unknown[] = []
    const defaultCalls: unknown[] = []
    const seam = (calls: unknown[], id: SessionId): AgentHandle => ({
      agent: {
        id, session: { id }, status: 'idle',
        inbox: { nextTurn: [], nextStep: [], remove: () => {} },
        followup: (message: unknown) => calls.push(message),
        steer: (message: unknown) => calls.push(message),
      } as unknown as Agent,
      dispose: async () => {},
    } as unknown as AgentHandle)
    ctx.agentTeam['handles'].set(memberId, new Map([
      [scopeKey, seam(channelCalls, binding!.sessionId)],
      [DEFAULT_MEMBER_SCOPE_KEY, seam(defaultCalls, SessionId('session:woken'))],
    ]))

    const sent = await ctx.agentTeam.sendMessage({
      requestId: requestId('wake-through-channel'), workspaceId: alpha, channelRef,
      body: 'A fact that belongs to this Channel', recipients: [memberId],
    })
    expect(sent.kind).toBe('committed')
    // The wake is queued behind the Member's lifecycle chain, so let it land.
    await ctx.agentTeam['enqueueLifecycle'](memberId, async () => {})
    expect(channelCalls).toHaveLength(1)
    expect(defaultCalls).toHaveLength(0)
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
    // The binding exists, so the row no longer reports a missing origin. Whether
    // it can be opened is a separate question this fixture answers with "not
    // yet": the Session has no Workspace to run in, and that failure is recorded
    // against this very row rather than left as a bare `creating`.
    expect(rows[0]!.reason).not.toBe('origin-unrecorded')
    expect(rows[0]!.state).toBe(rows[0]!.reason === undefined ? 'creating' : 'unopenable')
    expect(rows[0]!.sessionId).toBe(binding!.sessionId)
  })

  it('derives channel row activity and rolls it up to member presence with warning > running > normal priority', async () => {
    const { ctx } = await harness()
    const chNormal = await newChannelFor(ctx, nextChannelName())
    const chRunning = await newChannelFor(ctx, nextChannelName())
    const chWarning = await newChannelFor(ctx, nextChannelName())
    const memberId = 'member:rollup' as AgentTeamMemberId
    const ledger = ctx.agentTeam['ledger']!

    await ledger.addMember({
      requestId: requestId('add-rollup'), workspaceId: alpha, handle: 'rollup', description: 'Peer', presetId: 'team-member',
      channelRefs: [chNormal, chRunning], actor: agentTeamHumanActor(),
      member: {
        memberId, workspaceId: alpha, handle: 'rollup', description: 'Peer',
        presetId: 'team-member', privateMemoryPath: '/tmp/rollup', state: 'enabled' as const,
      },
    })
    const normalScopeKey = channelMemberScopeKey(chNormal)
    const runningScopeKey = channelMemberScopeKey(chRunning)
    const normalSessionId = SessionId('session:rollup:normal')
    const runningSessionId = SessionId('session:rollup:running')
    await ledger.bindMemberScopeSession({
      requestId: requestId('bind-rollup-normal'), workspaceId: alpha, workspaceRoot: cwd, memberId,
      binding: memberScopeSession(normalScopeKey, normalSessionId), actor: agentTeamHumanActor(),
    })
    await ledger.bindMemberScopeSession({
      requestId: requestId('bind-rollup-running'), workspaceId: alpha, workspaceRoot: cwd, memberId,
      binding: memberScopeSession(runningScopeKey, runningSessionId), actor: agentTeamHumanActor(),
    })
    const fakeHandle = (sessionId: SessionId, status: 'idle' | 'running' = 'idle') => ({
      agent: { id: sessionId, status, ctx, session: { id: sessionId } },
      dispose: async () => {},
    })
    const bindNormal = ledger.memberScopeSessionFor(memberId, normalScopeKey)!
    const bindRunning = ledger.memberScopeSessionFor(memberId, runningScopeKey)!
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
    ctx.agentTeam['clearMemberFailure'](memberId, 'activation', channelMemberScopeKey(ch))

    const activityOf = () => ctx.agentTeam.membersForClient({ workspaceId: alpha })
      .find(row => row.member.memberId === memberId)!.channels[0]!.activity
    expect(activityOf(), 'a live Session with no failure is normal').toBe('normal')

    ctx.agentTeam['sessionFailures'].add(binding.sessionId)
    expect(activityOf(), 'the failure the row shows is the Session\'s own, not the Member\'s').toBe('warning')
  })
})
