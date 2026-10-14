/**
 * Requirement 9 — the Human todo checklist, from the ledger's side.
 *
 * The checklist exists so a Member can put an ask in front of the Human and
 * have the Human answer it once, in the Thread it belongs to, with the Host
 * remembering which ask that was. Every case below is one sentence of that
 * promise: the same ask raised twice is one todo, a second identical action
 * changes nothing, the wrong actor cannot act at all, a replay of the durable
 * records rebuilds the same checklist, and the Channel badge counts what the
 * Host derived rather than what a client happened to load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
// A boot here opens a throwaway Domain every case, and the ledger replays its
// whole durable record set on construction — work the windows lane has stretched
// well past vitest's 5s default for sibling suites.
vi.setConfig({ testTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import type { AgentTeamLedgerResult } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type {
  AgentTeamAgentMember,
  AgentTeamChannelRef,
  AgentTeamHumanTodo,
  AgentTeamHumanTodoResult,
  AgentTeamMemberActor,
  AgentTeamMessageRef,
  AgentTeamOperation,
  AgentTeamOperationId,
  AgentTeamRequestId,
  AgentTeamThreadRef,
} from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

const workspaceId = WorkspaceId('workspace:human-todos')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

interface TodoFixture {
  readonly ledger: AgentTeamLedger
  readonly facility: DomainFacility
  /** The Channel the seeded Thread lives in — the one a checklist hangs off. */
  readonly channelRef: AgentTeamChannelRef
  /** A second, empty Channel, so the badge count has to report a zero. */
  readonly idleChannelRef: AgentTeamChannelRef
  readonly threadRef: AgentTeamThreadRef
  /** Another Thread of the same Channel, which carries none of the asks. */
  readonly otherThreadRef: AgentTeamThreadRef
  /** The Thread revision a Human reply must be based on. */
  readonly revision: number
  readonly memberId: AgentTeamAgentMember['memberId']
  readonly actor: AgentTeamMemberActor
  /** A second Member of the same Workspace: its asks are its own. */
  readonly otherActor: AgentTeamMemberActor
  /** The Human's actor, the only authority a claim or an answer accepts. */
  readonly humanActor: ReturnType<typeof agentTeamHumanActor>
}

/** A second ledger over the same durable records: the replay the Host performs at mount. */
function replayOf(fixture: TodoFixture): AgentTeamLedger {
  return new AgentTeamLedger(fixture.facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

function applied<T>(result: AgentTeamLedgerResult<T>): T {
  if (!result.committed) throw new Error(`expected this call to write a record, received ${JSON.stringify(result.value)}`)
  return result.value
}

/** One Member, two Channels, and two Threads — only the first of which is asked in. */
async function fixture(): Promise<TodoFixture> {
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
  const memberId = 'member:todos' as AgentTeamAgentMember['memberId']
  const member: AgentTeamAgentMember = {
    memberId,
    sessionId: SessionId('session:todos'),
    workspaceId,
    handle: 'todos',
    description: 'Todo fixture Member',
    presetId: 'team-member',
    privateMemoryPath: '/tmp/member:todos',
    state: 'enabled',
  }
  await ledger.addMember({ requestId: requestId('add:todos'), actor: agentTeamHumanActor(), workspaceId, handle: member.handle,
    description: member.description, presetId: member.presetId, channelRefs: [], member })
  const actor: AgentTeamMemberActor = { kind: 'member', memberId, handle: member.handle }
  const otherMemberId = 'member:todos-two' as AgentTeamAgentMember['memberId']
  await ledger.addMember({ requestId: requestId('add:todos-two'), actor: agentTeamHumanActor(), workspaceId, handle: 'todos-two',
    description: 'Second todo fixture Member', presetId: 'team-member', channelRefs: [],
    member: { ...member, memberId: otherMemberId, sessionId: SessionId('session:todos-two'), handle: 'todos-two',
      privateMemoryPath: '/tmp/member:todos-two' } })
  const otherActor: AgentTeamMemberActor = { kind: 'member', memberId: otherMemberId, handle: 'todos-two' }
  const created = applied(await ledger.createChannel({ requestId: requestId('channel:work'), actor: agentTeamHumanActor(), workspaceId,
    name: 'work', description: 'Todo fixture Channel', memberIds: [memberId] }))
  const idle = applied(await ledger.createChannel({ requestId: requestId('channel:idle'), actor: agentTeamHumanActor(), workspaceId,
    name: 'idle', description: 'Channel with no todos', memberIds: [memberId] }))
  const sent = applied(await ledger.sendMessage({ requestId: requestId('message:seed'), actor, workspaceId,
    channelRef: created.channel.channelRef, body: 'The ask this Thread carries', asTask: false }))
  if (sent.kind !== 'committed') throw new Error(`seed message committed as '${sent.kind}'`)
  const elsewhere = applied(await ledger.sendMessage({ requestId: requestId('message:elsewhere'), actor, workspaceId,
    channelRef: created.channel.channelRef, body: 'A Thread nobody is asked in', asTask: false }))
  if (elsewhere.kind !== 'committed') throw new Error(`second seed message committed as '${elsewhere.kind}'`)
  return { ledger, facility, channelRef: created.channel.channelRef, idleChannelRef: idle.channel.channelRef,
    threadRef: sent.thread.threadRef, otherThreadRef: elsewhere.thread.threadRef, revision: sent.thread.revision,
    memberId, actor, otherActor, humanActor: agentTeamHumanActor() }
}

/** Dispatch the fixture's ask, which most cases start from. */
async function dispatch(test: TodoFixture, value: string, title = 'Approve the release'): Promise<AgentTeamHumanTodoResult> {
  return applied(await test.ledger.dispatchHumanTodo({ requestId: requestId(value), actor: test.actor, workspaceId,
    threadRef: test.threadRef, title }))
}

function action(
  test: TodoFixture,
  value: string,
  todo: AgentTeamHumanTodo,
  act: 'claim' | 'answer' | 'close' | 'cancel',
  actor: AgentTeamMemberActor | ReturnType<typeof agentTeamHumanActor> = test.actor,
  messageRef?: AgentTeamMessageRef,
): Promise<AgentTeamLedgerResult<AgentTeamHumanTodoResult>> {
  return test.ledger.changeHumanTodo({ requestId: requestId(value), actor, workspaceId, todoRef: todo.todoRef, action: act,
    ...(messageRef === undefined ? {} : { messageRef }) })
}

describe('Human todo ledger', () => {
  it('dispatches an ask as a pending todo carrying its Channel, Thread and requester', async () => {
    const test = await fixture()
    const result = await dispatch(test, 'todo:dispatch')
    expect(result.changed, 'the first dispatch writes the record').toBe(true)
    expect(result.receipt, 'a written dispatch answers with its own receipt').toBeDefined()
    expect(result.todo).toEqual({
      todoRef: result.todo.todoRef, channelRef: test.channelRef, threadRef: test.threadRef, requester: test.memberId,
      title: 'Approve the release', normalizedTitle: 'approve the release', state: 'pending',
    })
    expect(result.todo.todoRef.startsWith('todo:'), 'a todo ref carries its own ref kind').toBe(true)
    expect(test.ledger.listHumanTodos({ workspaceId }, test.memberId).todos).toEqual([result.todo])
  })

  it('resolves a same-request retry of a dispatch without writing or claiming a change', async () => {
    const test = await fixture()
    const first = await dispatch(test, 'todo:replay-request')
    const again = await test.ledger.dispatchHumanTodo({ requestId: requestId('todo:replay-request'), actor: test.actor,
      workspaceId, threadRef: test.threadRef, title: first.todo.title })
    expect(again.committed, 'a replay of one requestId never commits again').toBe(false)
    expect(again.value.changed, 'and it reports that it wrote nothing').toBe(false)
    expect(again.value.receipt?.operationId, 'while still answering with the stored record').toBe(first.receipt?.operationId)
    expect(again.value.todo.todoRef).toBe(first.todo.todoRef)
    await expect(test.ledger.dispatchHumanTodo({ requestId: requestId('todo:replay-request'), actor: test.actor,
      workspaceId, threadRef: test.threadRef, title: 'A different ask' })).rejects.toThrow(/reused with a different operation or payload/)
  })

  it('folds a second requestId describing the same ask into the todo already standing', async () => {
    const test = await fixture()
    const first = await dispatch(test, 'todo:first')
    // Same ask, another request id, and the spacing/case a second Member types.
    const second = await test.ledger.dispatchHumanTodo({ requestId: requestId('todo:second'), actor: test.actor,
      workspaceId, threadRef: test.threadRef, title: '  approve   THE release ' })
    expect(second.committed, 'the duplicate writes no record at all').toBe(false)
    expect(second.value.changed, 'so the caller can say plainly that nothing was created').toBe(false)
    expect(second.value.receipt, 'and it points at no record of its own').toBeUndefined()
    expect(second.value.todo.todoRef).toBe(first.todo.todoRef)
    expect(test.ledger.listHumanTodos({ workspaceId }, test.memberId).todos).toHaveLength(1)
    test.ledger.validate()
  })

  it('treats the same title as a new ask once the earlier todo is settled', async () => {
    const test = await fixture()
    const first = await dispatch(test, 'todo:settled-first')
    applied(await action(test, 'todo:settled-close', first.todo, 'close'))
    const second = await dispatch(test, 'todo:settled-second')
    expect(second.changed, 'a settled todo releases its dedupe key').toBe(true)
    expect(second.todo.todoRef).not.toBe(first.todo.todoRef)
    expect(second.todo.state).toBe('pending')
    expect(test.ledger.listHumanTodos({ workspaceId }, test.memberId).todos).toHaveLength(2)
  })

  it('lets the Human claim an ask once and reports the second claim as no change', async () => {
    const test = await fixture()
    const { todo } = await dispatch(test, 'todo:claim')
    const claimed = applied(await action(test, 'todo:claim-1', todo, 'claim', test.humanActor))
    expect(claimed.changed).toBe(true)
    expect(claimed.todo.state).toBe('claimed')
    expect(claimed.todo.claimedBy).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    expect(claimed.todo.claimedSequence, 'a claim records when it happened').toBeGreaterThan(0)
    const again = await action(test, 'todo:claim-2', claimed.todo, 'claim', test.humanActor)
    expect(again.committed, 'claiming twice writes nothing').toBe(false)
    expect(again.value.changed).toBe(false)
    expect(again.value.todo).toEqual(claimed.todo)
    expect(test.ledger.listHumanTodos({ workspaceId }, test.memberId).todos[0]?.state).toBe('claimed')
    test.ledger.validate()
  })

  it('refuses a claim or an answer from the Member that asked', async () => {
    const test = await fixture()
    const { todo } = await dispatch(test, 'todo:authority')
    await expect(action(test, 'todo:member-claim', todo, 'claim')).rejects.toThrow(/Only the Human/)
    await expect(action(test, 'todo:member-answer', todo, 'answer')).rejects.toThrow(/Only the Human/)
    expect(test.ledger.listHumanTodos({ workspaceId }, test.memberId).todos[0]?.state, 'a refused action leaves the state alone').toBe('pending')
    // Closing and withdrawing are the requester's too: a Member may retire its own ask.
    expect(applied(await action(test, 'todo:member-cancel', todo, 'cancel')).todo.state).toBe('cancelled')
  })

  it("answers a todo only with the Human's own reply in that Thread", async () => {
    const test = await fixture()
    const { todo } = await dispatch(test, 'todo:answer')
    const memberVoice = applied(await test.ledger.reply({ requestId: requestId('reply:member'), actor: test.actor, workspaceId,
      threadRef: test.threadRef, baseRevision: test.revision, body: 'The Member answering for the Human' }))
    if (memberVoice.kind !== 'committed') throw new Error('the Member reply did not commit')
    await expect(action(test, 'todo:answer-wrong-sender', todo, 'answer', test.humanActor, memberVoice.message.messageRef))
      .rejects.toThrow(/the Human's own reply/)
    await expect(action(test, 'todo:answer-missing', todo, 'answer', test.humanActor)).rejects.toThrow(/messageRef/)
    await expect(action(test, 'todo:answer-extra-ref', todo, 'claim', test.humanActor, memberVoice.message.messageRef))
      .rejects.toThrow(/does not accept messageRef/)
    const humanVoice = applied(await test.ledger.reply({ requestId: requestId('reply:human'), actor: test.humanActor, workspaceId,
      threadRef: test.threadRef, baseRevision: memberVoice.thread.revision, body: 'Approved' }))
    if (humanVoice.kind !== 'committed') throw new Error('the Human reply did not commit')
    const answered = applied(await action(test, 'todo:answer-ok', todo, 'answer', test.humanActor, humanVoice.message.messageRef))
    expect(answered.todo.state).toBe('answered')
    expect(answered.todo.answeredMessageRef).toBe(humanVoice.message.messageRef)
    const again = await action(test, 'todo:answer-again', answered.todo, 'answer', test.humanActor, humanVoice.message.messageRef)
    expect(again.committed).toBe(false)
    expect(again.value.todo).toEqual(answered.todo)
    // A weaker fact never overwrites a stronger one: the answer already stands.
    const lateClaim = await action(test, 'todo:late-claim', answered.todo, 'claim', test.humanActor)
    expect(lateClaim.committed).toBe(false)
    expect(lateClaim.value.todo.state).toBe('answered')
    test.ledger.validate()
  })

  it('settles a todo once and refuses every later action', async () => {
    const test = await fixture()
    const { todo } = await dispatch(test, 'todo:close')
    const closed = applied(await action(test, 'todo:close-1', todo, 'close', test.humanActor))
    expect(closed.todo.state).toBe('closed')
    expect(closed.todo.resolvedBy).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    expect(closed.todo.resolvedSequence).toBeGreaterThan(0)
    const repeat = await action(test, 'todo:close-2', closed.todo, 'close', test.humanActor)
    expect(repeat.committed, 'closing a closed todo writes nothing').toBe(false)
    await expect(action(test, 'todo:close-cancel', closed.todo, 'cancel')).rejects.toThrow(/already closed/)
    await expect(action(test, 'todo:close-claim', closed.todo, 'claim', test.humanActor)).rejects.toThrow(/already closed/)
    await expect(action(test, 'todo:close-unknown', { ...todo, todoRef: 'todo:absent' as AgentTeamHumanTodo['todoRef'] }, 'close'))
      .rejects.toThrow(/unknown Human todo/)
  })

  it('drops a withdrawn ask from the checklist while a closed one stays', async () => {
    const test = await fixture()
    const withdrawn = await dispatch(test, 'todo:withdrawn')
    const kept = await dispatch(test, 'todo:kept', 'Sign off the migration note')
    applied(await action(test, 'todo:withdraw', withdrawn.todo, 'cancel'))
    const settled = applied(await action(test, 'todo:keep-closed', kept.todo, 'close', test.humanActor))
    expect(test.ledger.listHumanTodos({ workspaceId }, AGENT_TEAM_HUMAN_MEMBER_ID).todos,
      'a withdrawal is not on the checklist; the Human’s own close is').toEqual([settled.todo])
    expect(test.ledger.listHumanTodos({ workspaceId }, test.memberId).todos,
      'and the requester reads that same rule').toEqual([settled.todo])
    expect(test.ledger.listHumanTodos({ workspaceId }, test.memberId).channelCounts,
      'a withdrawal never reaches the badge either').toEqual([
      { channelRef: test.channelRef, count: 0 }, { channelRef: test.idleChannelRef, count: 0 },
    ])
    expect(test.ledger.listHumanTodos({ workspaceId, threadRef: test.threadRef }, test.memberId).todos,
      'nor a Thread-scoped read of the Thread it was asked in').toEqual([settled.todo])
    // The projection drops it; the fact does not go away: the record still
    // refuses every later action with the state it reached.
    await expect(action(test, 'todo:withdrawn-again', withdrawn.todo, 'close')).rejects.toThrow(/already cancelled/)
    const replay = replayOf(test)
    replay.validate()
    expect(replay.listHumanTodos({ workspaceId }, AGENT_TEAM_HUMAN_MEMBER_ID).todos,
      'and a replay of the records rebuilds the same checklist').toEqual([settled.todo])
  })

  it('counts unsettled todos per active Channel and hides other Members’ asks', async () => {
    const test = await fixture()
    const first = await dispatch(test, 'todo:count-1')
    await dispatch(test, 'todo:count-2', 'Sign off the migration note')
    await action(test, 'todo:count-claim', first.todo, 'claim', test.humanActor)
    const theirs = applied(await test.ledger.dispatchHumanTodo({ requestId: requestId('todo:count-theirs'), actor: test.otherActor,
      workspaceId, threadRef: test.otherThreadRef, title: 'A question only the other Member asked' }))
    const mine = test.ledger.listHumanTodos({ workspaceId }, test.memberId)
    expect(mine.todos, 'a Member sees only the asks it dispatched').toHaveLength(2)
    expect(mine.channelCounts, 'the badge count is derived per active Channel, a zero included').toEqual([
      { channelRef: test.channelRef, count: 3 }, { channelRef: test.idleChannelRef, count: 0 },
    ])
    expect(test.ledger.listHumanTodos({ workspaceId }, AGENT_TEAM_HUMAN_MEMBER_ID).todos.map(todo => todo.todoRef),
      'the Human sees every todo of the Workspace').toEqual([first.todo.todoRef, mine.todos[1]!.todoRef, theirs.todo.todoRef])
    expect(test.ledger.listHumanTodos({ workspaceId }, test.otherActor.memberId).todos,
      'and a Member never sees another Member’s ask').toEqual([theirs.todo])
    expect(test.ledger.listHumanTodos({ workspaceId, threadRef: test.otherThreadRef }, test.memberId).todos,
      'a Thread-scoped read answers only for its own Thread').toEqual([])
    applied(await action(test, 'todo:count-close', mine.todos[1]!, 'close', test.humanActor))
    expect(test.ledger.listHumanTodos({ workspaceId }, test.memberId).channelCounts,
      'a settled todo leaves the badge count while the claimed one stays').toEqual([
      { channelRef: test.channelRef, count: 2 }, { channelRef: test.idleChannelRef, count: 0 },
    ])
  })

  it('rebuilds the same checklist and Channel counts from the durable records alone', async () => {
    const test = await fixture()
    const { todo } = await dispatch(test, 'todo:replay')
    const claimed = applied(await action(test, 'todo:replay-claim', todo, 'claim', test.humanActor))
    await dispatch(test, 'todo:replay-open', 'A second open ask')
    const replay = replayOf(test)
    replay.validate()
    const expected = test.ledger.listHumanTodos({ workspaceId }, AGENT_TEAM_HUMAN_MEMBER_ID)
    expect(replay.listHumanTodos({ workspaceId }, AGENT_TEAM_HUMAN_MEMBER_ID),
      'a replay of the records rebuilds the very same checklist').toEqual(expected)
    const rebuilt = replay.listHumanTodos({ workspaceId }, AGENT_TEAM_HUMAN_MEMBER_ID).todos[0]!
    expect(rebuilt, 'including the claim and the moment it happened').toEqual(claimed.todo)
    expect(replay.listHumanTodos({ workspaceId }, test.memberId).channelCounts)
      .toEqual([{ channelRef: test.channelRef, count: 2 }, { channelRef: test.idleChannelRef, count: 0 }])
  })
})
