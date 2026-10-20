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
import type { AgentTeamChannelRef, AgentTeamMemberId } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const channelRef = 'channel:membership-origin' as AgentTeamChannelRef
const memberId = 'member:origin' as AgentTeamMemberId

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

function op(operationId: string, sequence: number, kind: string, data: object): AgentTeamOperation {
  return {
    operationId: operationId as AgentTeamOperationId,
    requestId: `request:${operationId}`,
    sequence,
    occurredAt: '2026-10-20T00:00:00.000Z',
    previousOperationId: sequence === 1 ? undefined : `operation:${sequence - 1}` as AgentTeamOperationId,
    actor: agentTeamHumanActor(),
    kind,
    data,
  } as unknown as AgentTeamOperation
}

async function ledgerWithOperations(): Promise<AgentTeamLedger> {
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

/** The ordered log the attribution scan reads; only these facts are consulted. */
function seed(ledger: AgentTeamLedger, operations: readonly AgentTeamOperation[]): void {
  (ledger['state'].ordered as AgentTeamOperation[]).push(...operations)
}

const created = (): AgentTeamOperation => op('operation:1', 1, 'team/channel-created', {
  workspaceId: alpha,
  channel: { channelRef, workspaceId: alpha, name: 'origin', description: '' },
  memberIds: [memberId],
})

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

  it('reports a removed membership with no later grant as un-attributable', async () => {
    const ledger = await ledgerWithOperations()
    seed(ledger, [created(), removed()])

    expect(ledger.channelMembershipOrigin(memberId, channelRef)).toBeUndefined()
  })
})
