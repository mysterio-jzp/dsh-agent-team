import { afterEach, describe, expect, it, vi } from 'vitest'
// Boots a Host per test; the shared harness in agent-team.spec.ts carries the
// same timeout argument for the same reason (cold replay on the windows lane).
vi.setConfig({ testTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type { AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../src/types.ts'

/**
 * Creating a Task is the President's write, and the refusal exists in TWO
 * places: the Host's sending path (a composed request that names asTask) and
 * the ledger's own write path (a direct caller). Each file here pins one of
 * them, because hiding the switch from the tool surface means a single-sided
 * test would let the other guard disappear unnoticed.
 *
 * Assertions name the STATE (holder / vacant / conflict) rather than the whole
 * sentence: the two implementations already word their refusals differently, and
 * pinning full text would break on wording while hiding that drift.
 */

const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

interface TeamHarness {
  readonly ctx: Context
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly facility: DomainFacility
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function harness(pool = new MemoryMediaPool()): Promise<TeamHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === alpha ? { id, path: process.cwd(), attachSession: async () => {} } : undefined,
    list: () => [{ id: alpha, path: process.cwd() }],
    archiveSession: async () => {},
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx, fiber, facility }
}

function ledgerOf(test: TeamHarness): AgentTeamLedger {
  return new AgentTeamLedger(test.facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

async function addMember(ledger: AgentTeamLedger, channelRef: string | undefined, memberId: string):
Promise<{ readonly member: AgentTeamAgentMember; readonly actor: AgentTeamMemberActor }> {
  const member: AgentTeamAgentMember = {
    memberId: memberId as never,
    sessionId: SessionId(`session:${memberId}`),
    workspaceId: alpha,
    handle: memberId.slice('member:'.length),
    description: 'Test Agent',
    presetId: 'team-member',
    privateMemoryPath: `/tmp/${memberId}`,
    state: 'enabled',
  }
  await ledger.addMember({ requestId: requestId(`add:${memberId}`), actor: agentTeamHumanActor(), member, handle: member.handle,
    description: member.description, presetId: member.presetId, workspaceId: alpha,
    channelRefs: channelRef === undefined ? [] : [channelRef as never] })
  return { member, actor: { kind: 'member', memberId: member.memberId, handle: member.handle } }
}

function storedPool(records: Array<[string, unknown]>): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('agent_team', agentTeamDomainSpec.version)
  pool.media.set('agent_team', { tables: new Map([['operations', new Map(records)]]), global: null })
  return pool
}

describe('Task creation authority', () => {
  it('refuses a Member that reaches the ledger directly without the office, and names the holder', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('authority-channel'), workspaceId: alpha, name: 'engineering', description: '' })
    const ledger = ledgerOf(test)
    // The first Member takes the office; the second one does not hold it.
    const { actor: holderActor } = await addMember(ledger, channel.channel.channelRef, 'member:holder')
    await ledger.setPresident({ requestId: requestId('authority-president'), actor: agentTeamHumanActor(), memberId: holderActor.memberId })
    const { actor: plainActor } = await addMember(ledger, channel.channel.channelRef, 'member:plain')

    // A direct caller never passes through the Host, so the tool surface that
    // omits `asTask` protects nothing here: the ledger's own guard is the only
    // thing standing between a Member and a Task.
    await expect(ledger.sendMessage({ asTask: true, requestId: requestId('direct-task'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Start work', actor: plainActor }))
      .rejects.toThrow(/^only the team President can create a Task.*holds the office/)
    // A plain Message stays open to every Member, so the refusal is about the
    // Task write and not about sending at all.
    const plain = await ledger.sendMessage({ requestId: requestId('direct-plain'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Thinking out loud', actor: plainActor })
    expect(plain.committed).toBe(true)
  })

  it('keeps the office holder able to create a Task through the same direct path', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('holder-channel'), workspaceId: alpha, name: 'engineering', description: '' })
    const ledger = ledgerOf(test)
    const { actor: holderActor } = await addMember(ledger, channel.channel.channelRef, 'member:holder')
    await ledger.setPresident({ requestId: requestId('holder-president'), actor: agentTeamHumanActor(), memberId: holderActor.memberId })

    // Reverse protection: an implementation that refuses everybody would pass
    // the refusal test above and fail here.
    const created = await ledger.sendMessage({ asTask: true, requestId: requestId('holder-task'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Start work', actor: holderActor })
    expect(created.committed).toBe(true)
    expect('task' in created.value ? created.value.task?.taskRef : undefined).toBeDefined()
  })

  it('lets the Human create a Task without the office', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('human-channel'), workspaceId: alpha, name: 'engineering', description: '' })
    const ledger = ledgerOf(test)
    await addMember(ledger, channel.channel.channelRef, 'member:holder')
    // The office is deliberately left vacant: the Human exemption has to hold
    // on its own, not because somebody happens to be President.
    expect(ledger.presidentState()).toEqual({ kind: 'vacant' })
    const created = await ledger.sendMessage({ asTask: true, requestId: requestId('human-task'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Start work', actor: agentTeamHumanActor() })
    expect(created.committed).toBe(true)
    expect('task' in created.value ? created.value.task?.taskRef : undefined).toBeDefined()
  })

  it('refuses every Member while the office is vacant and when the ledger records two holders', async () => {
    const vacant = await harness()
    const channel = await vacant.ctx.agentTeam.createChannel({ requestId: requestId('vacant-channel'), workspaceId: alpha, name: 'engineering', description: '' })
    const vacantLedger = ledgerOf(vacant)
    const { actor: vacantActor } = await addMember(vacantLedger, channel.channel.channelRef, 'member:plain')
    expect(vacantLedger.presidentState()).toEqual({ kind: 'vacant' })
    await expect(vacantLedger.sendMessage({ asTask: true, requestId: requestId('vacant-task'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Start work', actor: vacantActor }))
      .rejects.toThrow(/^only the team President can create a Task.*office is vacant/)

    // Two President flags are never produced by the write path, so the conflict
    // is loaded from a hand-carried ledger — the shape a hand edit or an older
    // writer leaves behind. Choosing one of them would hand out Task authority
    // silently, which is what the refusal exists to prevent.
    const source = await harness()
    const sourceChannel = await source.ctx.agentTeam.createChannel({ requestId: requestId('conflict-channel'), workspaceId: alpha, name: 'engineering', description: '' })
    await addMember(ledgerOf(source), sourceChannel.channel.channelRef, 'member:solo')
    const conflictRecords = [...source.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const firstIndex = conflictRecords.findIndex(([, operation]) => (operation as AgentTeamOperation).kind === 'team/member-added')
    const memberOperation = conflictRecords[firstIndex]![1] as AgentTeamOperation & { data: { member: AgentTeamAgentMember } }
    const twinId = 'member:twin'
    const twin: AgentTeamAgentMember = { ...memberOperation.data.member, memberId: twinId as never,
      sessionId: SessionId(`session:${twinId}`), handle: 'twin', privateMemoryPath: `/tmp/${twinId}` }
    // Both records carry the flag, and neither is cleared by the other.
    const flagged = conflictRecords.map(([id, operation]) => (operation as AgentTeamOperation).kind === 'team/member-added'
      ? [id, { ...(operation as AgentTeamOperation), data: { ...(operation as never as { data: Record<string, unknown> }).data, member: { ...memberOperation.data.member, president: true } } }] as [string, unknown]
      : [id, operation] as [string, unknown])
    const lastOperation = flagged[flagged.length - 1]![1] as AgentTeamOperation
    flagged.push([`operation:conflict-twin` as never as string, {
      ...lastOperation,
      sequence: lastOperation.sequence + 1,
      operationId: 'operation:conflict-twin',
      requestId: 'add:conflict-twin',
      previousOperationId: lastOperation.operationId,
      kind: 'team/member-added',
      data: { member: { ...twin, president: true }, channelRefs: [sourceChannel.channel.channelRef] },
    }])

    const conflicted = await harness(storedPool(flagged))
    const conflictedLedger = ledgerOf(conflicted)
    expect(conflictedLedger.presidentState()).toMatchObject({ kind: 'conflict' })
    await expect(conflictedLedger.sendMessage({ asTask: true, requestId: requestId('conflict-task'), workspaceId: alpha,
      channelRef: sourceChannel.channel.channelRef, body: 'Start work',
      actor: { kind: 'member', memberId: twinId as never, handle: 'twin' } }))
      .rejects.toThrow(/^only the team President can create a Task.*more than one President/)
  })
})
