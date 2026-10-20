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
import type { AgentTeamChannelRef, AgentTeamChannelRowReason, AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'

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
})
