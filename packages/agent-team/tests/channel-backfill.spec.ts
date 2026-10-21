/**
 * Backfilling the Members a Channel showed only through Thread participation.
 *
 * The derivation this repair freezes is temporary: a Member who took part in a
 * Thread of a Channel was treated as a member of it, so removing the derivation
 * would drop them out of Channels they were already being shown. The repair
 * writes the ordinary membership record a Human's own addition writes, and only
 * for the Channels it is asked about — another Channel's history is not this
 * repair's to freeze.
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
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../src/types.ts'
import { backfillDerivedChannelMemberships } from '../src/channel-backfill.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function ledgerFixture(): Promise<AgentTeamLedger> {
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
  return ledger
}

/** Whether a durable membership carries the pair, rather than Thread participation alone. */
function explicitlyEnrolled(ledger: AgentTeamLedger, channelRef: AgentTeamChannelRef, memberId: AgentTeamMemberId): boolean {
  return ledger.channelParticipations()
    .some(entry => entry.channelRef === channelRef && entry.memberId === memberId && entry.explicit)
}

const request = (name: string): AgentTeamRequestId => `request:${name}` as AgentTeamRequestId

async function newChannel(ledger: AgentTeamLedger, name: string): Promise<AgentTeamChannelRef> {
  const created = await ledger.createChannel({
    requestId: request(`create-${name}`), workspaceId: alpha, name, description: '',
    memberIds: [], actor: agentTeamHumanActor(),
  })
  return created.value.channel.channelRef
}

/**
 * An enabled Member outside the Channel who follows one of its Threads, so only
 * the Thread derivation makes them visible there. A membership would let them
 * write, which is exactly what must not happen before the repair.
 */
async function memberWhoFollowed(ledger: AgentTeamLedger, channelRef: AgentTeamChannelRef, handle: string): Promise<AgentTeamMemberId> {
  const memberId = `member:${handle}` as AgentTeamMemberId
  await ledger.addMember({
    requestId: request(`add-${handle}`), workspaceId: alpha, handle, description: 'Peer', presetId: 'team-member',
    channelRefs: [], actor: agentTeamHumanActor(),
    member: {
      memberId, sessionId: SessionId(`session:${handle}`), workspaceId: alpha, handle, description: 'Peer',
      presetId: 'team-member', privateMemoryPath: `/tmp/${handle}`, state: 'enabled',
    },
  })
  // A top-level Message opens the Channel's Thread; the Member reads it rather
  // than writes, which is the only way to be exposed without a membership.
  const opened = await ledger.sendMessage({
    requestId: request(`open-${handle}`), workspaceId: alpha, channelRef,
    body: 'background for the Channel', recipients: [], actor: agentTeamHumanActor(),
  })
  if (opened.value.kind !== 'committed') throw new Error(`opening the Thread did not commit: ${opened.value.kind}`)
  await ledger.changeAttention({
    requestId: request(`follow-${handle}`), workspaceId: alpha, channelRef,
    threadRef: opened.value.thread.threadRef, action: 'follow',
    actor: { kind: 'member', memberId, handle } as unknown as AgentTeamOperation['actor'],
  } as never)
  // `memberInChannel` reports the derivation too, so the fact that matters here
  // is that no membership carries the pair: that is what the repair writes.
  expect(explicitlyEnrolled(ledger, channelRef, memberId), 'followed, not enrolled').toBe(false)
  return memberId
}

describe('backfilling the Members a Channel showed through Thread participation', () => {
  it('enrols them for the named Channel only, and a re-run enrols nobody twice', async () => {
    const ledger = await ledgerFixture()
    const target = await newChannel(ledger, 'target')
    const other = await newChannel(ledger, 'other')
    const spoken = await memberWhoFollowed(ledger, target, 'spoken')
    const elsewhere = await memberWhoFollowed(ledger, other, 'elsewhere')

    expect(explicitlyEnrolled(ledger, target, spoken), 'not a Member until repaired').toBe(false)
    expect(explicitlyEnrolled(ledger, other, elsewhere), 'not a Member until repaired').toBe(false)

    const report = await backfillDerivedChannelMemberships(ledger, agentTeamHumanActor(), { channelRefs: [target] })

    expect(report.planned.map(entry => entry.memberId)).toEqual([spoken])
    expect(report.written, 'one enrolment was written').toBe(1)
    expect(explicitlyEnrolled(ledger, target, spoken), 'the named Channel now counts them explicitly').toBe(true)
    // The scope is the point of the option: the other Channel is exposed by the
    // same derivation and must come out of this repair exactly as it went in.
    expect(explicitlyEnrolled(ledger, other, elsewhere), 'another Channel is untouched').toBe(false)
    expect(ledger.channelParticipations().filter(entry => !entry.explicit).map(entry => entry.channelRef),
      'the other Channel is still derived').toEqual([other])

    const replay = await backfillDerivedChannelMemberships(ledger, agentTeamHumanActor(), { channelRefs: [target] })
    expect(replay.planned, 'nothing left to repair').toEqual([])
    expect(replay.written, 'a second run writes nothing').toBe(0)
  })

  it('leaves a Member who already holds a membership alone', async () => {
    const ledger = await ledgerFixture()
    const target = await newChannel(ledger, 'already')
    const seated = await memberWhoFollowed(ledger, target, 'seated')
    await ledger.joinChannel({
      requestId: request('seat'), workspaceId: alpha, channelRef: target, memberId: seated, actor: agentTeamHumanActor(),
    })

    const report = await backfillDerivedChannelMemberships(ledger, agentTeamHumanActor(), { channelRefs: [target] })

    expect(report.planned, 'an explicit membership is not a candidate').toEqual([])
    expect(report.written).toBe(0)
  })
})
