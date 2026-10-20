import { afterEach, describe, expect, it, vi } from 'vitest'
// Booting a Storage-backed Host per test has reached seconds on the windows
// lane; this file keeps headroom rather than betting on runner throughput.
vi.setConfig({ testTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { claimMessageArtifacts, MESSAGE_ARTIFACTS_PROJECTION_KEY, NOTHING_CLAIMED, presentedDeliveriesProjection } from '../src/message-artifacts.ts'
import type { PresentedTurnDeliveries } from '../src/message-artifacts.ts'
import type { AgentTeamChannelRef, AgentTeamMessageArtifact, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamSendMessageCommittedResult } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const cwd = process.cwd()
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const memberActor = (memberId: string): AgentTeamMemberActor => ({ kind: 'member', memberId: memberId as AgentTeamMemberId, handle: 'peer' })
const human = agentTeamHumanActor()
const sessionId = SessionId('session:declaring')

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** A live Session whose delivery fold is registered exactly as the Host registers it. */
async function declaringSession(): Promise<{ readonly ctx: Context; readonly session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(presentedDeliveriesProjection)
  cleanups.push(async () => { await ctx.fiber.dispose() })
  return { ctx, session: ctx.sessions.create(sessionId, { meta: { cwd } }) }
}

function declare(session: Session, turn: number, callId: string, files: Array<{ readonly path: string; readonly description?: string }>): void {
  session.append('deliverables/presented', { turn, callId: ToolCallId(callId), files })
}

function deliveries(ctx: Context, session: Session): PresentedTurnDeliveries | undefined {
  return ctx.sessionProjections.stateOf(session, MESSAGE_ARTIFACTS_PROJECTION_KEY)
}

async function openLedger(pool = new MemoryMediaPool()): Promise<{ readonly ledger: AgentTeamLedger; readonly pool: MemoryMediaPool }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  const table = domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
  const ledger = new AgentTeamLedger(table)
  await ledger.initialize()
  return { ledger, pool }
}

/** One Channel holding one Member — the sender every artifact assertion below measures. */
async function teamWithMember(ledger: AgentTeamLedger): Promise<{ readonly channelRef: AgentTeamChannelRef; readonly memberId: AgentTeamMemberId }> {
  const channel = (await ledger.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: '', memberIds: [], actor: human })).value.channel
  const memberId = 'member:peer' as AgentTeamMemberId
  const added = await ledger.addMember({
    requestId: requestId('add-peer'), workspaceId: alpha, handle: 'peer', description: 'Peer', presetId: 'team-member',
    channelRefs: [channel.channelRef], actor: human,
    member: {
      memberId, sessionId: SessionId('session:member:peer'), workspaceId: alpha, handle: 'peer', description: 'Peer',
      presetId: 'team-member', privateMemoryPath: '/tmp/peer', state: 'enabled',
    },
  })
  // Creating a Task is the President's write; this fixture's Member sends a
  // Task, so it takes the vacant office — the Human designation production
  // requires.
  await ledger.setPresident({ requestId: requestId('add-peer-president'), actor: human, memberId: added.value.member.memberId })
  return { channelRef: channel.channelRef, memberId: added.value.member.memberId }
}

/** The committed arm of a send; the confirmation and unread-required arms are not this suite's subject. */
function sent(result: { readonly value: { readonly kind: string } }): AgentTeamSendMessageCommittedResult {
  if (result.value.kind !== 'committed') throw new Error(`expected a committed Message, received ${result.value.kind}`)
  return result.value as AgentTeamSendMessageCommittedResult
}

const artifact = (id: string, path: string, description?: string): AgentTeamMessageArtifact => ({
  sessionId: id as AgentTeamMessageArtifact['sessionId'],
  path,
  ...(description === undefined ? {} : { description }),
})

describe('presented deliveries fold', () => {
  it('folds this turn, replaces it on the next turn, and drops a declaration that arrives too late', async () => {
    const { ctx, session } = await declaringSession()
    expect(deliveries(ctx, session), 'a Session that never presented carries nothing').toEqual({ turn: -1, deliveries: [] })

    session.append('turn/start', { turn: 1 })
    declare(session, 1, 'call:1', [{ path: 'docs/a.md', description: 'The report' }])
    declare(session, 1, 'call:2', [{ path: 'docs/b.md' }])
    expect(deliveries(ctx, session)).toEqual({
      turn: 1,
      deliveries: [
        { callId: 'call:1', files: [{ path: 'docs/a.md', description: 'The report' }] },
        { callId: 'call:2', files: [{ path: 'docs/b.md' }] },
      ],
    })

    // One call records one delivery: a replayed result cannot double a card.
    declare(session, 1, 'call:2', [{ path: 'docs/b.md' }])
    expect(deliveries(ctx, session)).toMatchObject({ deliveries: [{ callId: 'call:1' }, { callId: 'call:2' }] })

    // A new turn starts clean, and a nested result landing afterwards is no
    // longer a declaration of the turn a Message can claim from.
    session.append('turn/start', { turn: 2 })
    expect(deliveries(ctx, session)).toEqual({ turn: 2, deliveries: [] })
    declare(session, 1, 'call:3', [{ path: 'docs/late.md' }])
    expect(deliveries(ctx, session)).toEqual({ turn: 2, deliveries: [] })
  })
})

describe('claiming declarations for one Message', () => {
  it('claims a turn once, resolving a relative path against the declaring Session', async () => {
    const { ctx, session } = await declaringSession()
    session.append('turn/start', { turn: 1 })
    declare(session, 1, 'call:1', [{ path: 'docs/a.md', description: 'The report' }, { path: '/elsewhere/absolute.md' }])
    declare(session, 1, 'call:2', [{ path: 'docs/a.md' }])
    const folded = deliveries(ctx, session)

    const claim = claimMessageArtifacts(session.id, session.header.cwd, folded, new Set())
    expect(claim.artifacts).toEqual([
      artifact(session.id, `${cwd}/docs/a.md`, 'The report'),
      artifact(session.id, '/elsewhere/absolute.md'),
    ])
    expect(claim.callIds).toEqual(['call:1', 'call:2'])

    // The next Message of the same turn claims nothing: a declaration belongs
    // to the Message it preceded, not to every Message after it.
    expect(claimMessageArtifacts(session.id, cwd, folded, new Set(claim.callIds))).toEqual(NOTHING_CLAIMED)
    expect(claimMessageArtifacts(session.id, cwd, undefined, new Set())).toEqual(NOTHING_CLAIMED)
    expect(claimMessageArtifacts(session.id, cwd, { turn: 1, deliveries: [] }, new Set())).toEqual(NOTHING_CLAIMED)
  })

  it('drops a relative declaration no working directory can anchor, while spending its call', async () => {
    const { ctx, session } = await declaringSession()
    session.append('turn/start', { turn: 0 })
    declare(session, 0, 'call:1', [{ path: 'docs/a.md' }, { path: '/elsewhere/absolute.md' }])
    const claim = claimMessageArtifacts(session.id, undefined, deliveries(ctx, session), new Set())
    expect(claim.artifacts).toEqual([artifact(session.id, '/elsewhere/absolute.md')])
    expect(claim.callIds).toEqual(['call:1'])
  })
})

describe('the Message fact', () => {
  it('stores claimed artifacts, replays a retry, and cold-reopens with them', async () => {
    const { ledger, pool } = await openLedger()
    const team = await teamWithMember(ledger)
    const delivered = [artifact('session:member', `${cwd}/docs/report.md`, 'The report')]
    const sentMessage = await ledger.sendMessage({
      requestId: requestId('member-message'), actor: memberActor(team.memberId), workspaceId: alpha,
      channelRef: team.channelRef, body: 'The report is ready', asTask: true, resolvedArtifacts: delivered,
    })
    expect(sent(sentMessage).message.artifacts).toEqual(delivered)

    // A retry that resolved a different surface replays the stored Message: the
    // artifacts are the Message's content, so comparing them would turn one
    // repeated requestId into a different request.
    const retried = await ledger.sendMessage({
      requestId: requestId('member-message'), actor: memberActor(team.memberId), workspaceId: alpha,
      channelRef: team.channelRef, body: 'The report is ready', asTask: true,
      resolvedArtifacts: [artifact('session:member', `${cwd}/docs/later.md`)],
    })
    expect(retried.committed).toBe(false)
    expect(sent(retried).message.artifacts).toEqual(delivered)

    // The durable field must survive a cold reopen: a Message field the storage
    // schema does not name fails to parse on the next Host boot. The reopen
    // goes through raw records → a fresh pool → a fresh domain `open()`, so the
    // operation schema really runs; reusing an already-open domain would read
    // memory and pass even with the field missing.
    const reopened = await openLedger(pool)
    const history = reopened.ledger.threadHistory(human, { workspaceId: alpha, threadRef: sent(sentMessage).thread.threadRef })
    const stored = [history.anchor, ...history.facts.flatMap(fact => fact.kind === 'message' ? [fact.message] : [])]
      .find(candidate => candidate.messageRef === sent(sentMessage).message.messageRef)
    expect(stored?.artifacts).toEqual(delivered)
  })

  it('leaves artifacts off a Human Message and off a Member Message that claimed none', async () => {
    const { ledger } = await openLedger()
    const team = await teamWithMember(ledger)
    const fromHuman = await ledger.sendMessage({
      requestId: requestId('human-message'), actor: human, workspaceId: alpha,
      channelRef: team.channelRef, body: 'Please deliver the report', asTask: true,
    })
    expect(sent(fromHuman).message.artifacts).toBeUndefined()

    const fromMember = await ledger.sendMessage({
      requestId: requestId('plain-member-message'), actor: memberActor(team.memberId), workspaceId: alpha,
      channelRef: team.channelRef, body: 'Working on it', resolvedArtifacts: [],
    })
    expect(sent(fromMember).message.artifacts).toBeUndefined()
  })
})
