/**
 * Attribution of a Channel membership recorded by the Channel's creation.
 *
 * `createChannel` names its initial Members on the `team/channel-created`
 * operation itself, so that operation is the Human act that made those
 * memberships and the one their work domain is credited to. A ledger written
 * before Channel membership became derived from participation can also hold a
 * later `team/channel-member-removed`, and something has to decide what a
 * retired grant means: the grant itself is void, but the Member is not thereby
 * source-less — a later grant still speaks for it.
 *
 * Those older shapes have no writer left (the removal request path is retired
 * and its apply/validate branches stay only for replay), so this file states
 * them as operations rather than reaching them through a request. The scan is
 * a pure read of the ordered log, which is exactly what the cases below feed.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type { AgentTeamOperation, AgentTeamOperationId } from '../src/types.ts'
import type { AgentTeamAgentMember } from '../src/types.ts'
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamMessageRef, AgentTeamRequestId, AgentTeamThreadRef } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const channelRef = 'channel:membership-origin' as AgentTeamChannelRef
const memberId = 'member:origin' as AgentTeamMemberId
const coldMemberId = 'member:cold0a' as AgentTeamMemberId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

const member: AgentTeamAgentMember = {
  memberId,
  sessionId: SessionId('session:origin'),
  workspaceId: alpha,
  handle: 'origin',
  description: '',
  presetId: 'team-member',
  privateMemoryPath: '/tmp/origin',
  state: 'enabled',
}

function op(
  operationId: string,
  sequence: number,
  kind: string,
  data: object,
  actor: AgentTeamOperation['actor'] = agentTeamHumanActor(),
): AgentTeamOperation {
  return {
    operationId: operationId as AgentTeamOperationId,
    requestId: `request:${operationId}`,
    sequence,
    occurredAt: '2026-10-20T00:00:00.000Z',
    previousOperationId: sequence === 1 ? undefined : `operation:${sequence - 1}` as AgentTeamOperationId,
    actor,
    kind,
    data,
  } as unknown as AgentTeamOperation
}

interface LedgerFixture {
  readonly ledger: AgentTeamLedger
  readonly facility: DomainFacility
}

async function ledgerFixture(): Promise<LedgerFixture> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  const ledger = new AgentTeamLedger(domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
  await ledger.initialize()
  return { ledger, facility }
}

async function ledgerWithOperations(): Promise<AgentTeamLedger> {
  return (await ledgerFixture()).ledger
}

/** A media pool preloaded with stored records: the raw bytes a Host restart reads. */
function storedPool(records: Array<[string, unknown]>): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('agent_team', agentTeamDomainSpec.version)
  pool.media.set('agent_team', { tables: new Map([['operations', new Map(records)]]), global: null })
  return pool
}

/**
 * The Host's mount path: the same raw records opened by a *fresh* domain.
 *
 * This is the only place a stored record meets its schema — the write path does
 * not validate — so a durable field the schema does not declare fails right
 * here, on `open()`, taking the whole ledger domain down with it. A second
 * ledger over an already-open domain would not: it reads memory, never the
 * schema. That asymmetry is why the cold case below exists at all.
 */
async function reopen(records: Array<[string, unknown]>): Promise<AgentTeamLedger> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(storedPool(records)))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  const ledger = new AgentTeamLedger(domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
  await ledger.initialize()
  return ledger
}

/** The ordered log the attribution scan reads; only these facts are consulted. */
function seed(ledger: AgentTeamLedger, operations: readonly AgentTeamOperation[]): void {
  (ledger['state'].ordered as AgentTeamOperation[]).push(...operations)
}

const created = (actor?: AgentTeamOperation['actor']): AgentTeamOperation => op(
  'operation:1',
  1,
  'team/channel-created',
  {
    workspaceId: alpha,
    channel: { channelRef, workspaceId: alpha, name: 'origin', description: '' },
    memberIds: [memberId],
  },
  actor,
)

const removed = (): AgentTeamOperation => op('operation:2', 2, 'team/channel-member-removed', {
  workspaceId: alpha, channelRef, memberId,
  claims: [], activities: [], tasks: [], threads: [],
  inbox: { notices: [], threads: [] },
})

const addedBack = (): AgentTeamOperation => op('operation:3', 3, 'team/member-added', {
  member, channelRefs: [channelRef],
})

describe('Channel membership attribution', () => {
  it('credits a membership granted by the Channel creation to that creation', async () => {
    const ledger = await ledgerWithOperations()
    seed(ledger, [created()])

    expect(ledger.channelMembershipOrigin(memberId, channelRef)?.operationId).toBe('operation:1')
  })

  it('credits a Member granted, removed and granted again to the later grant', async () => {
    const ledger = await ledgerWithOperations()
    seed(ledger, [created(), removed(), addedBack()])

    // The retired create-time grant does not answer for a membership a later
    // Human act made, and it does not silence that act either.
    expect(ledger.channelMembershipOrigin(memberId, channelRef)?.operationId).toBe('operation:3')
  })

  it('walks past a create-time grant an agent recorded instead of a Human', async () => {
    const ledger = await ledgerWithOperations()
    // `createChannel` calls `assertHumanActor` before committing, so no
    // production path can write this shape today; it is stated here for the
    // same reason the retired removal is: the scan is a pure read of the log,
    // and a log that holds one must not read as "this Member has no source"
    // while a valid later grant sits behind it.
    const agentActor = { kind: 'member', memberId } as unknown as AgentTeamOperation['actor']
    seed(ledger, [created(agentActor), addedBack()])

    expect(ledger.channelMembershipOrigin(memberId, channelRef)?.operationId).toBe('operation:3')
  })

  it('reports a removed membership with no later grant as un-attributable', async () => {
    const ledger = await ledgerWithOperations()
    seed(ledger, [created(), removed()])

    expect(ledger.channelMembershipOrigin(memberId, channelRef)).toBeUndefined()
  })
})

/**
 * A recorded participation carries two authorities that must stay separable:
 * the Message that invited the Member, frozen exactly as it was written, and
 * the Human whose invitation it was.
 *
 * They are stored apart because only the second is an authorization. A source
 * written by a Member is a real thing — it is how the Member got here — but it
 * is not the Human's consent, and a Ledger that overwrote its actor with the
 * responsible Human could no longer tell the two apart. That is why the
 * `actor=member` case below is the one that matters: written the other way, the
 * Human-source cases would read identically and prove nothing.
 */
describe('Enrolment by being named', () => {
  it('enrols a Member the body names, and records it as ordinary Channel membership', async () => {
    const test = await ledgerFixture()
    // Two Members share the Workspace but not the Channel. Naming one in a
    // Message is what should put them in it.
    const invited = 'member:mention1' as AgentTeamMemberId
    const bystander = 'member:bystand2' as AgentTeamMemberId
    await test.ledger.addMember({
      requestId: 'request:add-invited' as AgentTeamRequestId, workspaceId: alpha, handle: 'invited', description: '',
      presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
      member: { ...member, memberId: invited, handle: 'invited', sessionId: SessionId('session:invited'), privateMemoryPath: '/tmp/invited' },
    })
    await test.ledger.addMember({
      requestId: 'request:add-bystander' as AgentTeamRequestId, workspaceId: alpha, handle: 'bystander', description: '',
      presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
      member: { ...member, memberId: bystander, handle: 'bystander', sessionId: SessionId('session:bystander'), privateMemoryPath: '/tmp/bystander' },
    })
    const created = await test.ledger.createChannel({
      requestId: 'request:create-mention' as AgentTeamRequestId, workspaceId: alpha, name: 'mentions', description: '',
      memberIds: [], actor: agentTeamHumanActor(),
    })
    const liveChannelRef = created.value.channel.channelRef
    expect(test.ledger.memberInChannel(liveChannelRef, invited), 'not in the Channel until named').toBe(false)

    await test.ledger.sendMessage({
      requestId: 'request:name-invited' as AgentTeamRequestId, workspaceId: alpha, channelRef: liveChannelRef,
      body: 'welcome @invited', recipients: [], actor: agentTeamHumanActor(),
    })

    // The enrolment is the same durable record a Human adding them by hand
    // writes, so the read gate and the roster agree without a second rule.
    expect(test.ledger.memberInChannel(liveChannelRef, invited)).toBe(true)
    expect(test.ledger.channelParticipations().find(entry => entry.memberId === invited)?.explicit).toBe(true)
    // The Member nobody named is untouched: naming one person is not @all.
    expect(test.ledger.memberInChannel(liveChannelRef, bystander)).toBe(false)
  })

  it('cold reopen: an enrolment written by naming someone survives the durable schema', async () => {
    const test = await ledgerFixture()
    const invited = 'member:coldinv5' as AgentTeamMemberId
    // A real history: the cold read replays the log in sequence order, so a
    // seeded shape with a fabricated sequence would fail as a replay defect
    // rather than test the schema.
    await test.ledger.addMember({
      requestId: 'request:add-cold-invited' as AgentTeamRequestId, workspaceId: alpha, handle: 'invited', description: '',
      presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
      member: { ...member, memberId: invited, handle: 'invited', sessionId: SessionId('session:cold-invited'), privateMemoryPath: '/tmp/cold-invited' },
    })
    const created = await test.ledger.createChannel({
      requestId: 'request:create-cold-invited' as AgentTeamRequestId, workspaceId: alpha, name: 'cold-invited', description: '',
      memberIds: [], actor: agentTeamHumanActor(),
    })
    const liveChannelRef = created.value.channel.channelRef
    await test.ledger.sendMessage({
      requestId: 'request:name-cold-invited' as AgentTeamRequestId, workspaceId: alpha, channelRef: liveChannelRef,
      body: 'welcome @invited', recipients: [], actor: agentTeamHumanActor(),
    })
    expect(test.ledger.memberInChannel(liveChannelRef, invited)).toBe(true)

    // The Host's mount path: a fresh domain over the same raw records. The
    // enrolment rides on `team/channel-member-added`, so this proves that the
    // record a Message now writes replays, not only that the send returned.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()]
    const cold = await reopen(records)

    expect(cold.memberInChannel(liveChannelRef, invited), 'a cold read still counts the enrolment').toBe(true)
    expect(cold.channelParticipations().find(entry => entry.memberId === invited && entry.channelRef === liveChannelRef)?.explicit,
      'the enrolment is explicit membership after a cold read, not a derived row').toBe(true)
    // Attribution survives too: the reconciliation pass credits the binding to
    // the enrolment act, so a cold ledger can open the Channel's Session.
    expect(cold.channelMembershipOrigin(invited, liveChannelRef), 'the enrolment is its own origin').toBeDefined()
  })

  it('writes one enrolment per named Member however often the send is retried', async () => {
    const test = await ledgerFixture()
    const invited = 'member:retry04' as AgentTeamMemberId
    await test.ledger.addMember({
      requestId: 'request:add-retry' as AgentTeamRequestId, workspaceId: alpha, handle: 'retry', description: '',
      presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
      member: { ...member, memberId: invited, handle: 'retry', sessionId: SessionId('session:retry'), privateMemoryPath: '/tmp/retry' },
    })
    const created = await test.ledger.createChannel({
      requestId: 'request:create-retry' as AgentTeamRequestId, workspaceId: alpha, name: 'retry', description: '',
      memberIds: [], actor: agentTeamHumanActor(),
    })
    const liveChannelRef = created.value.channel.channelRef
    const request = {
      requestId: 'request-retry-once' as AgentTeamRequestId, workspaceId: alpha, channelRef: liveChannelRef,
      body: 'welcome @retry', recipients: [] as readonly AgentTeamMemberId[], actor: agentTeamHumanActor(),
    }
    await test.ledger.sendMessage(request)
    // The retry resolves against the recorded request before reaching the
    // enrolment, so the log must not gain a second join for the same name.
    const retried = await test.ledger.sendMessage(request)
    expect(retried.committed, 'a retry resolves the recorded Message').toBe(false)
    const joins = test.ledger['state'].ordered.filter(operation => operation.kind === 'team/channel-member-added'
      && (operation as { data: { memberId: AgentTeamMemberId } }).data.memberId === invited)
    expect(joins.length, 'one enrolment, not two').toBe(1)
  })

  it('does not enrol anyone the message only reached through @all', async () => {
    const test = await ledgerFixture()
    const bystander = 'member:allbyst3' as AgentTeamMemberId
    await test.ledger.addMember({
      requestId: 'request:add-all-bystander' as AgentTeamRequestId, workspaceId: alpha, handle: 'bystander', description: '',
      presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
      member: { ...member, memberId: bystander, handle: 'bystander', sessionId: SessionId('session:all-bystander'), privateMemoryPath: '/tmp/all-bystander' },
    })
    const created = await test.ledger.createChannel({
      requestId: 'request:create-all' as AgentTeamRequestId, workspaceId: alpha, name: 'all', description: '',
      memberIds: [], actor: agentTeamHumanActor(),
    })
    const liveChannelRef = created.value.channel.channelRef

    await test.ledger.sendMessage({
      requestId: 'request-say-all' as unknown as AgentTeamRequestId, workspaceId: alpha, channelRef: liveChannelRef,
      body: 'hello @all', recipients: [], actor: agentTeamHumanActor(),
    })

    // `@all` addresses the room; it is not an invitation list. Reading it as
    // one would let a single Message enrol everyone the body could name.
    expect(test.ledger.memberInChannel(liveChannelRef, bystander), 'the room was addressed, not the Member').toBe(false)
  })
})
