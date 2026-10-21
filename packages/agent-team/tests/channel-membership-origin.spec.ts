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
import type { AgentTeamChannelMemberAddedOperation, AgentTeamChannelMemberRemovedOperation, AgentTeamOperation, AgentTeamOperationId } from '../src/types.ts'
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

const emptyReleaseSnapshot = {
  claims: [], activities: [], tasks: [], threads: [],
  inbox: {
    attention: { set: [], removed: [] },
    directMarkers: { added: [], removed: [] },
    activityMarkers: { added: [], removed: [] },
  },
}

function channelMemberRemoved(
  ledger: AgentTeamLedger, requestId: AgentTeamRequestId,
  channelRef: AgentTeamChannelRef, memberId: AgentTeamMemberId,
): AgentTeamChannelMemberRemovedOperation {
  const sequence = ledger['nextSequence']()
  const projection = ledger['state']
  const threadRefs = ledger['channelThreadRefsFrom'](projection, channelRef)
  const inbox = ledger['removeMemberThreadInboxFrom'](projection, memberId, threadRefs)
  return Object.freeze({
    ...ledger['operationBase']({ requestId, actor: agentTeamHumanActor() }, sequence),
    kind: 'team/channel-member-removed',
    data: Object.freeze({ workspaceId: alpha, channelRef, memberId, ...emptyReleaseSnapshot, inbox }),
  }) as AgentTeamChannelMemberRemovedOperation
}

function channelMemberAdded(
  ledger: AgentTeamLedger, requestId: AgentTeamRequestId,
  channelRef: AgentTeamChannelRef, memberId: AgentTeamMemberId,
  actor: AgentTeamOperation['actor'], mentionedByMessageRef?: AgentTeamMessageRef,
): AgentTeamChannelMemberAddedOperation {
  const sequence = ledger['nextSequence']()
  return Object.freeze({
    ...ledger['operationBase']({ requestId, actor }, sequence),
    kind: 'team/channel-member-added',
    data: Object.freeze({ workspaceId: alpha, channelRef, memberId,
      ...(mentionedByMessageRef === undefined ? {} : { mentionedByMessageRef }) }),
  }) as AgentTeamChannelMemberAddedOperation
}

async function commitOperation(ledger: AgentTeamLedger, operation: AgentTeamOperation): Promise<void> {
  await ledger['table'].put(operation.operationId, operation)
  ledger['apply'](operation)
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

  it('cold replay credits a rejoin to the later Human grant', async () => {
    const test = await ledgerFixture()
    const author = 'member:rejoined1' as AgentTeamMemberId
    await test.ledger.addMember({
      requestId: 'request:add-rejoined' as AgentTeamRequestId, workspaceId: alpha, handle: 'rejoined', description: '',
      presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
      member: { ...member, memberId: author, handle: 'rejoined', sessionId: SessionId('session:rejoined'), privateMemoryPath: '/tmp/rejoined' },
    })
    const created = await test.ledger.createChannel({
      requestId: 'request:create-rejoined' as AgentTeamRequestId, workspaceId: alpha, name: 'rejoined', description: '',
      memberIds: [author], actor: agentTeamHumanActor(),
    })
    const liveChannelRef = created.value.channel.channelRef
    await commitOperation(test.ledger, channelMemberRemoved(
      test.ledger, 'request:remove-rejoined' as AgentTeamRequestId, liveChannelRef, author))
    const renewed = channelMemberAdded(test.ledger, 'request:rejoin-rejoined' as AgentTeamRequestId,
      liveChannelRef, author, agentTeamHumanActor())
    await commitOperation(test.ledger, renewed)

    const records = [...test.facility.get('agent_team')!.table('operations').entries()]
    const cold = await reopen(records)
    expect(cold.channelMembershipOrigin(author, liveChannelRef)?.operationId,
      'the old grant is retired and the rejoin names its own Human act').toBe(renewed.operationId)
  })

  it('cold replay keeps a regranted Member source after a Member-authored grant is withdrawn', async () => {
    const test = await ledgerFixture()
    const root = 'member:rootown1' as AgentTeamMemberId
    const author = 'member:author01' as AgentTeamMemberId
    const invited = 'member:invite01' as AgentTeamMemberId
    for (const [id, handle] of [[root, 'rootowner'], [author, 'author01'], [invited, 'invite01']] as const) {
      await test.ledger.addMember({
        requestId: `request:add-${handle}` as AgentTeamRequestId, workspaceId: alpha, handle, description: '',
        presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
        member: { ...member, memberId: id, handle, sessionId: SessionId(`session:${handle}`), privateMemoryPath: `/tmp/${handle}` },
      })
    }
    const created = await test.ledger.createChannel({
      requestId: 'request:create-member-grant' as AgentTeamRequestId, workspaceId: alpha, name: 'member-grant', description: '',
      memberIds: [root], actor: agentTeamHumanActor(),
    })
    const liveChannelRef = created.value.channel.channelRef
    await test.ledger.sendMessage({
      requestId: 'request:root-names-author' as AgentTeamRequestId, workspaceId: alpha, channelRef: liveChannelRef,
      body: 'welcome @author01', recipients: [], actor: { kind: 'member', memberId: root, handle: 'rootowner' },
    })
    const oldGrant = test.ledger['state'].ordered.find(operation => operation.kind === 'team/channel-member-added'
      && (operation as AgentTeamChannelMemberAddedOperation).data.memberId === author) as AgentTeamChannelMemberAddedOperation | undefined
    expect(oldGrant?.actor.kind, 'the retired source is a Member-authored enrolment').toBe('member')

    await commitOperation(test.ledger, channelMemberRemoved(
      test.ledger, 'request:remove-member-grant' as AgentTeamRequestId, liveChannelRef, author))
    const renewed = channelMemberAdded(test.ledger, 'request:human-regrant-member' as AgentTeamRequestId,
      liveChannelRef, author, agentTeamHumanActor())
    await commitOperation(test.ledger, renewed)
    await test.ledger.sendMessage({
      requestId: 'request:author-renames-invite' as AgentTeamRequestId, workspaceId: alpha, channelRef: liveChannelRef,
      body: 'welcome @invite01', recipients: [], actor: { kind: 'member', memberId: author, handle: 'author01' },
    })

    const records = [...test.facility.get('agent_team')!.table('operations').entries()]
    const cold = await reopen(records)
    expect(cold.channelMembershipOrigin(author, liveChannelRef)?.operationId,
      'the retired Member grant is skipped in favor of the Human regrant').toBe(renewed.operationId)
  })

  it('cold replay keeps a regranted Member source after a member-added grant is withdrawn', async () => {
    const test = await ledgerFixture()
    const author = 'member:author02' as AgentTeamMemberId
    const invited = 'member:invite02' as AgentTeamMemberId
    await test.ledger.addMember({
      requestId: 'request:add-invite02' as AgentTeamRequestId, workspaceId: alpha, handle: 'invite02', description: '',
      presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
      member: { ...member, memberId: invited, handle: 'invite02', sessionId: SessionId('session:invite02'), privateMemoryPath: '/tmp/invite02' },
    })
    const created = await test.ledger.createChannel({
      requestId: 'request:create-member-added' as AgentTeamRequestId, workspaceId: alpha, name: 'member-added', description: '',
      memberIds: [], actor: agentTeamHumanActor(),
    })
    const liveChannelRef = created.value.channel.channelRef
    await test.ledger.addMember({
      requestId: 'request:add-author02' as AgentTeamRequestId, workspaceId: alpha, handle: 'author02', description: '',
      presetId: 'team-member', channelRefs: [liveChannelRef], actor: agentTeamHumanActor(),
      member: { ...member, memberId: author, handle: 'author02', sessionId: SessionId('session:author02'), privateMemoryPath: '/tmp/author02' },
    })
    await commitOperation(test.ledger, channelMemberRemoved(
      test.ledger, 'request:remove-member-added' as AgentTeamRequestId, liveChannelRef, author))
    const renewed = channelMemberAdded(test.ledger, 'request:human-regrant-member-added' as AgentTeamRequestId,
      liveChannelRef, author, agentTeamHumanActor())
    await commitOperation(test.ledger, renewed)
    await test.ledger.sendMessage({
      requestId: 'request:author02-names-invite' as AgentTeamRequestId, workspaceId: alpha, channelRef: liveChannelRef,
      body: 'welcome @invite02', recipients: [], actor: { kind: 'member', memberId: author, handle: 'author02' },
    })

    const records = [...test.facility.get('agent_team')!.table('operations').entries()]
    const cold = await reopen(records)
    expect(cold.channelMembershipOrigin(author, liveChannelRef)?.operationId,
      'the retired member-added grant is skipped in favor of the Human regrant').toBe(renewed.operationId)
  })

  it('cold replay rejects a Member enrolment after its Human grant was withdrawn', async () => {
    const test = await ledgerFixture()
    const author = 'member:retired2' as AgentTeamMemberId
    const invited = 'member:named09' as AgentTeamMemberId
    for (const [id, handle] of [[author, 'retired'], [invited, 'named09']] as const) {
      await test.ledger.addMember({
        requestId: `request:add-${handle}` as AgentTeamRequestId, workspaceId: alpha, handle, description: '',
        presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
        member: { ...member, memberId: id, handle, sessionId: SessionId(`session:${handle}`), privateMemoryPath: `/tmp/${handle}` },
      })
    }
    const created = await test.ledger.createChannel({
      requestId: 'request:create-prefix' as AgentTeamRequestId, workspaceId: alpha, name: 'prefix', description: '',
      memberIds: [author], actor: agentTeamHumanActor(),
    })
    const liveChannelRef = created.value.channel.channelRef
    await commitOperation(test.ledger, channelMemberRemoved(
      test.ledger, 'request:remove-prefix' as AgentTeamRequestId, liveChannelRef, author))
    expect(test.ledger.channelMembershipOrigin(author, liveChannelRef), 'the old grant no longer answers').toBeUndefined()

    // Workspace participation still permits this historical Message; only an
    // enrolment resting on the withdrawn Channel grant must fail replay.
    const sent = await test.ledger.sendMessage({
      requestId: 'request:prefix-names' as AgentTeamRequestId, workspaceId: alpha, channelRef: liveChannelRef,
      body: 'over to @named09', recipients: [], actor: { kind: 'member', memberId: author, handle: 'retired' },
    })
    if (sent.value.kind !== 'committed') throw new Error('the Message should commit despite the withdrawn Channel grant')
    expect(test.ledger['state'].memberships.get(liveChannelRef)?.has(invited), 'the write guard withholds the enrolment').toBe(false)

    const records = [...test.facility.get('agent_team')!.table('operations').entries()]
    const validCold = await reopen(records)
    expect(validCold.channelMembershipOrigin(author, liveChannelRef)).toBeUndefined()

    // Model the invalid durable row the pre-fix writer could have left behind.
    // On cold replay this Member-authored enrolment must be rejected because
    // its Message sender has no Human-root grant in the prefix.
    const invalid = channelMemberAdded(test.ledger, 'request:invalid-enrolment' as AgentTeamRequestId,
      liveChannelRef, invited, { kind: 'member', memberId: author, handle: 'retired' }, sent.value.message.messageRef)
    await expect(reopen([...records, [invalid.operationId, invalid]])).rejects.toThrow(/no Human behind the enrolment/)
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

  it('cold reopen: an enrolment a Member wrote by naming someone replays as valid', async () => {
    const test = await ledgerFixture()
    // The Host validates the log on the way back in, and this enrolment is
    // authored by a Member rather than the Human. Its authority is the Human the
    // author's own membership reaches, not the actor itself — a shape only
    // reachable through this path, which is why it needs its own replay case.
    const author = 'member:author05' as AgentTeamMemberId
    const invited = 'member:named05' as AgentTeamMemberId
    await test.ledger.addMember({
      requestId: 'request:add-author' as AgentTeamRequestId, workspaceId: alpha, handle: 'author', description: '',
      presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
      member: { ...member, memberId: author, handle: 'author', sessionId: SessionId('session:author'), privateMemoryPath: '/tmp/author' },
    })
    await test.ledger.addMember({
      requestId: 'request:add-named' as AgentTeamRequestId, workspaceId: alpha, handle: 'named', description: '',
      presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
      member: { ...member, memberId: invited, handle: 'named', sessionId: SessionId('session:named'), privateMemoryPath: '/tmp/named' },
    })
    const created = await test.ledger.createChannel({
      requestId: 'request:create-named' as AgentTeamRequestId, workspaceId: alpha, name: 'named', description: '',
      memberIds: [author], actor: agentTeamHumanActor(),
    })
    const liveChannelRef = created.value.channel.channelRef
    await test.ledger.sendMessage({
      requestId: 'request:author-names-named' as AgentTeamRequestId, workspaceId: alpha, channelRef: liveChannelRef,
      body: 'over to @named', recipients: [], actor: { kind: 'member', memberId: author, handle: 'author' },
    })
    expect(test.ledger.memberInChannel(liveChannelRef, invited), 'naming enrols regardless of who wrote it').toBe(true)

    const records = [...test.facility.get('agent_team')!.table('operations').entries()]
    const cold = await reopen(records)

    expect(cold.memberInChannel(liveChannelRef, invited), 'the enrolment a Member wrote replays').toBe(true)
    // The act still rests on the Human who put the author in the Channel.
    expect(cold.channelMembershipOrigin(invited, liveChannelRef), 'a Member-authored enrolment resolves to its Human root').toBeDefined()
  })

  it('naming someone does not enrol when the author has no Human root', async () => {
    // The write must not commit a record the replay would reject: that shape is
    // what took the whole domain down. The guard asks the SAME predicate the
    // replay asks, so an author whose own membership reaches no Human leaves no
    // enrolment behind — and nothing is left to discover at the next cold start.
    const test = await ledgerFixture()
    const rootless = 'member:rootless7' as AgentTeamMemberId
    const invited = 'member:named07' as AgentTeamMemberId
    for (const [id, handle] of [[rootless, 'rootless'], [invited, 'named07']] as const) {
      await test.ledger.addMember({
        requestId: `request:add-${handle}` as AgentTeamRequestId, workspaceId: alpha, handle, description: '',
        presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor(),
        member: { ...member, memberId: id, handle, sessionId: SessionId(`session:${handle}`), privateMemoryPath: `/tmp/${handle}` },
      })
    }
    const created = await test.ledger.createChannel({
      requestId: 'request:create-rootless' as AgentTeamRequestId, workspaceId: alpha, name: 'rootless', description: '',
      memberIds: [], actor: agentTeamHumanActor(),
    })
    const liveChannelRef = created.value.channel.channelRef
    // No Human act put the author in this Channel. `requireMemberChannel` checks
    // Workspace participation only, so they may still send — and their Message
    // is the rootless authority the guard must refuse to act on.
    expect(test.ledger.channelMembershipOrigin(rootless, liveChannelRef), 'no Human act put them in it').toBeUndefined()

    // The Message itself lands; only the enrolment it implies is withheld.
    await test.ledger.sendMessage({
      requestId: 'request:rootless-names' as AgentTeamRequestId, workspaceId: alpha, channelRef: liveChannelRef,
      body: 'over to @named07', recipients: [], actor: { kind: 'member', memberId: rootless, handle: 'rootless' },
    })
    const enrolments = test.ledger['state'].ordered.filter(operation => operation.kind === 'team/channel-member-added'
      && (operation as { data: { memberId: AgentTeamMemberId } }).data.memberId === invited)
    expect(enrolments.length, 'no enrolment record was written').toBe(0)
    // The decisive check: the log reopens, so no rejected record was committed.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()]
    const cold = await reopen(records)
    expect(cold.channelMembershipOrigin(invited, liveChannelRef), 'and the log still replays').toBeUndefined()
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
