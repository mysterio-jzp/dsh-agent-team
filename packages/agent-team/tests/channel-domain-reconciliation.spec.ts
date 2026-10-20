/**
 * Startup reconciliation for Channel work domains.
 *
 * The pass backfills a domain for a membership a previous run committed but
 * never bound. What it must never do is invent the attribution: a binding the
 * ledger cannot trace to the act that created the membership is reported as a
 * readable failure, because a placeholder signature would leave the ledger
 * unable to tell a real binding from a backfilled one.
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
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const cwd = process.cwd()
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
let channelCounter = 0
/** A distinct Channel name per test; createChannel rejects a duplicate name. */
function nextChannelName(): string {
  channelCounter += 1
  return `reconcile-${channelCounter}`
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
 * A Member joined to a Channel with NO work domain bound — the state a crash
 * between the membership commit and the domain commit leaves behind. The
 * membership is committed through the ledger directly so the Host's own
 * join-time domain creation does not run.
 */
async function joinedWithoutDomain(
  ctx: Context, channelRef: AgentTeamChannelRef, handle: string, withAdditionOperation: boolean,
): Promise<AgentTeamMemberId> {
  const memberId = `member:${handle}` as AgentTeamMemberId
  const sessionId = SessionId(`session:${handle}`)
  const ledger = ctx.agentTeam['ledger']!
  // The membership itself always rides on the Member's creation, which is where
  // a real addition records it. What differs between the two shapes is only
  // whether the granting operation survives as an attributable origin.
  await ledger.addMember({
    requestId: requestId(`add-${handle}`), workspaceId: alpha, handle, description: 'Peer', presetId: 'team-member',
    channelRefs: withAdditionOperation ? [channelRef] : [], actor: agentTeamHumanActor(),
    member: {
      memberId, sessionId, workspaceId: alpha, handle, description: 'Peer',
      presetId: 'team-member', privateMemoryPath: `/tmp/${handle}`, state: 'enabled' as const,
    },
  })
  if (!withAdditionOperation) {
    // Membership without its originating operation: the un-attributable shape
    // an older ledger presents. Written straight into the projection so the pass
    // sees a joined Member whose origin is genuinely absent.
    const memberships = ledger['state'].memberships
    const members = memberships.get(channelRef) ?? new Set<AgentTeamMemberId>()
    members.add(memberId)
    memberships.set(channelRef, members)
  }
  return memberId
}

describe('startup reconciliation of Channel work domains', () => {
  it('backfills a domain and attributes it to the act that added the Member', async () => {
    const { ctx } = await harness()
    const channelRef = await newChannelFor(ctx, nextChannelName())
    const memberId = await joinedWithoutDomain(ctx, channelRef, 'joined', true)

    await ctx.agentTeam['reconcileChannelWorkDomains'](ctx.agentTeam['ledger']!)

    const bound = ctx.agentTeam['ledger']!.memberScopeSessionFor(memberId, channelMemberScopeKey(channelRef))
    expect(bound).toBeDefined()
    // The pointer is what makes the backfilled record traceable to its cause.
    const operation = ctx.agentTeam['ledger']!['state'].ordered.find(entry => entry.kind === 'team/member-scope-session-bound')
    expect(operation).toBeDefined()
    expect((operation as { data: { sourceOperationId?: string } }).data.sourceOperationId).toBeDefined()
  })

  it('reports an un-attributable membership as a readable failure instead of binding it', async () => {
    const { ctx } = await harness()
    const channelRef = await newChannelFor(ctx, nextChannelName())
    const memberId = await joinedWithoutDomain(ctx, channelRef, 'orphan', false)

    await ctx.agentTeam['reconcileChannelWorkDomains'](ctx.agentTeam['ledger']!)

    // No domain: the binding is what must NOT exist, since a binding here could
    // only carry an invented operator.
    expect(ctx.agentTeam['ledger']!.memberScopeSessionFor(memberId, channelMemberScopeKey(channelRef))).toBeUndefined()
    const status = ctx.agentTeam.members().find(row => row.member.memberId === memberId)
    expect(status?.diagnostic?.class).toBe('domain-unattributed')
    expect(status?.diagnostic?.detail).toContain('record of when it joined that Channel is missing')
  })

  it('opens nothing twice when the pass runs again over an already-bound membership', async () => {
    const { ctx } = await harness()
    const channelRef = await newChannelFor(ctx, nextChannelName())
    const memberId = await joinedWithoutDomain(ctx, channelRef, 'twice', true)

    await ctx.agentTeam['reconcileChannelWorkDomains'](ctx.agentTeam['ledger']!)
    const first = ctx.agentTeam['ledger']!.memberScopeSessionFor(memberId, channelMemberScopeKey(channelRef))
    await ctx.agentTeam['reconcileChannelWorkDomains'](ctx.agentTeam['ledger']!)
    const second = ctx.agentTeam['ledger']!.memberScopeSessionFor(memberId, channelMemberScopeKey(channelRef))

    expect(first).toBeDefined()
    expect(second?.sessionId).toBe(first?.sessionId)
    const boundCount = ctx.agentTeam['ledger']!['state'].ordered
      .filter(entry => entry.kind === 'team/member-scope-session-bound').length
    expect(boundCount).toBe(1)
  })
})

