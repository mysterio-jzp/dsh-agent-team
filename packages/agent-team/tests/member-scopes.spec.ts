/**
 * Work-domain buckets — the durable half of context isolation.
 *
 * One discussion is one bucket, and a bucket is the Session its facts are
 * delivered into. These cases cover the three things that make that safe to
 * land: the key is derived from immutable refs alone (so `promoteThread` cannot
 * move it), a binding is created lazily and only for a domain that has facts,
 * and both a binding and a scoped Session transition survive a cold reopen of
 * the ledger — the way the Host performs it at mount.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AgentTeamLedger, agentTeamHumanActor, memberScopeBindRequestId } from '../src/ledger.ts'
import type { AgentTeamLedgerResult, AgentTeamMemberScopeBoundResult } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { DEFAULT_MEMBER_SCOPE_KEY, channelMemberScopeKey, parseMemberScopeKey } from '../src/member-scope.ts'
import type {
  AgentTeamAgentMember,
  AgentTeamChannelRef,
  AgentTeamMemberScopeKey,
  AgentTeamOperation,
  AgentTeamOperationId,
  AgentTeamRequestId,
  AgentTeamThreadRef,
} from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const workspaceId = WorkspaceId('workspace:scopes')
const workspaceRoot = process.cwd()
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

function applied<T>(result: AgentTeamLedgerResult<T>): T {
  if (!result.committed) throw new Error(`expected this call to write a record, received ${JSON.stringify(result.value)}`)
  return result.value
}

interface ScopeFixture {
  readonly ledger: AgentTeamLedger
  readonly facility: DomainFacility
  readonly memberId: AgentTeamAgentMember['memberId']
  readonly channelRef: AgentTeamChannelRef
  /** The first discussion of the fixture Channel: a source of facts, never a domain of its own. */
  readonly threadRef: AgentTeamThreadRef
  readonly revision: number
  /** A second discussion in the SAME Channel; it shares the Channel's domain with `threadRef`. */
  readonly otherThreadRef: AgentTeamThreadRef
  /** A second Channel of the same Workspace — the only thing that makes a second domain. */
  readonly otherChannelRef: AgentTeamChannelRef
}

/** One Member, two Channels; the first Channel carries two discussions. No bucket bound yet. */
async function fixture(): Promise<ScopeFixture> {
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
  const memberId = 'member:scoped' as AgentTeamAgentMember['memberId']
  const member: AgentTeamAgentMember = {
    memberId,
    sessionId: SessionId('session:scoped-default'),
    workspaceId,
    handle: 'scoped',
    description: 'Scope fixture Member',
    presetId: 'team-member',
    privateMemoryPath: '/tmp/member:scoped',
    state: 'enabled',
  }
  await ledger.addMember({ requestId: requestId('add'), actor: agentTeamHumanActor(), workspaceId, handle: member.handle,
    description: member.description, presetId: member.presetId, channelRefs: [], member })
  const actor = { kind: 'member' as const, memberId, handle: member.handle }
  const channel = applied(await ledger.createChannel({ requestId: requestId('channel'), actor: agentTeamHumanActor(), workspaceId,
    name: 'scopes', description: 'Scope fixture Channel', memberIds: [memberId] }))
  const sent = applied(await ledger.sendMessage({ requestId: requestId('message'), actor, workspaceId,
    channelRef: channel.channel.channelRef, body: 'The first discussion', asTask: false }))
  if (sent.kind !== 'committed') throw new Error(`seed message committed as '${sent.kind}'`)
  const other = applied(await ledger.sendMessage({ requestId: requestId('message-other'), actor, workspaceId,
    channelRef: channel.channel.channelRef, body: 'The second discussion', asTask: false }))
  if (other.kind !== 'committed') throw new Error(`second seed message committed as '${other.kind}'`)
  // A second Channel of the same Workspace: the fixture's only source of a
  // second work domain, because a Thread no longer splits one Channel's domain.
  const otherChannel = applied(await ledger.createChannel({ requestId: requestId('channel-other'), actor: agentTeamHumanActor(), workspaceId,
    name: 'scopes-other', description: 'A second Scope fixture Channel', memberIds: [memberId] }))
  return { ledger, facility, memberId, channelRef: channel.channel.channelRef, threadRef: sent.thread.threadRef,
    revision: sent.thread.revision, otherThreadRef: other.thread.threadRef, otherChannelRef: otherChannel.channel.channelRef }
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
 * not validate — so a durable field that the schema does not declare fails right
 * here, on `open()`, with the whole ledger domain down. A second ledger over the
 * already-open domain would not: it reads memory, never the schema.
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
  expect(() => ledger.validate()).not.toThrow()
  return ledger
}

async function restart(test: ScopeFixture): Promise<AgentTeamLedger> {
  const records = [...test.facility.get('agent_team')!.table('operations').entries()]
  return reopen(records)
}

/**
 * Bind one domain to a fresh Session the way the Host does on a first delivery.
 * The record's receipt travels with the binding, so the answer is the result
 * object and its `binding` is what the domain reads.
 */
function bind(fixture: ScopeFixture, scopeKey: AgentTeamMemberScopeKey, sessionId: SessionId): Promise<AgentTeamLedgerResult<AgentTeamMemberScopeBoundResult>> {
  return fixture.ledger.bindMemberScopeSession({
    requestId: memberScopeBindRequestId(fixture.memberId, scopeKey),
    workspaceId,
    workspaceRoot,
    memberId: fixture.memberId,
    binding: { scopeKey, sessionId, scopeKind: parseMemberScopeKey(scopeKey).scopeKind,
      ...(parseMemberScopeKey(scopeKey).scopeRef === undefined ? {} : { scopeRef: parseMemberScopeKey(scopeKey).scopeRef }) },
    actor: agentTeamHumanActor(),
  })
}

describe('Member work-domain keys', () => {
  it('keys a Channel from immutable refs alone', () => {
    const channelRef = 'channel:abc' as AgentTeamChannelRef
    // The ref already names its own kind; the key adds the domain namespace so
    // a key can never be read as some other kind of ref.
    expect(channelMemberScopeKey(channelRef)).toBe('channel:channel:abc')
    expect(DEFAULT_MEMBER_SCOPE_KEY).toBe('default')
    for (const [key, kind, ref] of [
      ['channel:channel:abc', 'channel', 'channel:abc'],
      ['default', 'default', undefined],
    ] as const) {
      expect(parseMemberScopeKey(key), `key '${key}' round-trips`).toEqual({ scopeKind: kind, ...(ref === undefined ? {} : { scopeRef: ref }) })
    }
  })

  it('rejects a key it did not write instead of defaulting an unknown domain into the legacy Session', () => {
    expect(() => parseMemberScopeKey('task:task:abc')).toThrow(/unknown scope kind 'task'/)
    // A Channel is the only work domain this bundle writes. A Thread key is no
    // longer readable at all: a ledger carrying one is corrupt, and reading it
    // as some unknown live domain would deliver facts no reader can resolve.
    expect(() => parseMemberScopeKey('thread:thread:abc')).toThrow(/unknown scope kind 'thread'/)
    expect(() => parseMemberScopeKey('dm:member:peer')).toThrow(/unknown scope kind 'dm'/)
    expect(() => parseMemberScopeKey('channel:')).toThrow(/carries no ref/)
    expect(() => parseMemberScopeKey('nocolon')).toThrow(/carries no namespace/)
  })
})

describe('Member work-domain directory snapshots', () => {
  it('applies Channel defaults and Member overrides when a Channel first binds, and replays the snapshot', async () => {
    const test = await fixture()
    const channelDefaults = ['/tmp/channel-first', '/tmp/channel-shared']
    const memberOverride = ['/tmp/member-first', '/tmp/member-extra']
    applied(await test.ledger.updateChannelWorkingDirectories({ requestId: requestId('dirs-channel-first'), actor: agentTeamHumanActor(),
      workspaceId, channelRef: test.channelRef, workingDirectories: channelDefaults }))
    const overrideResult = applied(await test.ledger.updateChannelMemberWorkingDirectories({ requestId: requestId('dirs-member-first'),
      actor: agentTeamHumanActor(), workspaceId, channelRef: test.channelRef, memberId: test.memberId, workingDirectories: memberOverride }))
    expect(overrideResult.workingDirectories).toEqual(memberOverride)

    const firstKey = channelMemberScopeKey(test.channelRef)
    const first = applied(await bind(test, firstKey, SessionId('session:dirs-first'))).binding
    expect(first.workingDirectories).toEqual(memberOverride)

    // Edits after first bind affect only future, unbound domains.
    const channelLater = ['/tmp/channel-later', '/tmp/channel-shared']
    const defaultsRequest = { requestId: requestId('dirs-channel-later'), actor: agentTeamHumanActor(), workspaceId,
      channelRef: test.channelRef, workingDirectories: channelLater }
    applied(await test.ledger.updateChannelWorkingDirectories(defaultsRequest))
    applied(await test.ledger.updateChannelMemberWorkingDirectories({ requestId: requestId('dirs-member-clear'), actor: agentTeamHumanActor(),
      workspaceId, channelRef: test.channelRef, memberId: test.memberId, workingDirectories: null }))

    // A second domain is now a second CHANNEL, so it resolves that Channel's own
    // defaults rather than the edits made to the first one.
    const otherDefaults = ['/tmp/other-channel', '/tmp/channel-shared']
    applied(await test.ledger.updateChannelWorkingDirectories({ requestId: requestId('dirs-other-channel'), actor: agentTeamHumanActor(),
      workspaceId, channelRef: test.otherChannelRef, workingDirectories: otherDefaults }))
    const secondKey = channelMemberScopeKey(test.otherChannelRef)
    const second = applied(await bind(test, secondKey, SessionId('session:dirs-second'))).binding
    expect(second.workingDirectories).toEqual(otherDefaults)
    expect(test.ledger.memberScopeSessionFor(test.memberId, firstKey)?.workingDirectories).toEqual(memberOverride)

    const retry = await bind(test, firstKey, SessionId('session:dirs-first'))
    expect(retry.committed).toBe(false)
    expect(retry.value.binding.workingDirectories).toEqual(memberOverride)

    // Clearing a Channel's default restores its Workspace-root fallback for the
    // domains bound after the clear, without changing an already bound one.
    applied(await test.ledger.updateChannelWorkingDirectories({ requestId: requestId('dirs-other-clear'), actor: agentTeamHumanActor(),
      workspaceId, channelRef: test.otherChannelRef, workingDirectories: null }))

    expect(test.ledger.channelWorkingDirectorySettings({ workspaceId, channelRef: test.otherChannelRef })).toEqual({
      channelRef: test.otherChannelRef, defaultWorkingDirectories: null, memberOverrides: [],
    })
    const cold = await restart(test)
    expect(cold.memberScopeSessionFor(test.memberId, firstKey)?.workingDirectories).toEqual(memberOverride)
    expect(cold.memberScopeSessionFor(test.memberId, secondKey)?.workingDirectories).toEqual(otherDefaults)
    // The FIRST Channel keeps its edited default; the second is the one cleared.
    expect(cold.channelWorkingDirectorySettings({ workspaceId, channelRef: test.channelRef }).defaultWorkingDirectories).toEqual(channelLater)
    expect(cold.channelWorkingDirectorySettings({ workspaceId, channelRef: test.otherChannelRef }).defaultWorkingDirectories).toBeNull()
    const coldRetry = await bind({ ...test, ledger: cold }, firstKey, SessionId('session:dirs-first'))
    expect(coldRetry.committed).toBe(false)
    expect(coldRetry.value.binding.workingDirectories).toEqual(memberOverride)
  })

  it('normalizes ordered absolute paths, limits the set size, and makes updates idempotent', async () => {
    const test = await fixture()
    const configured = ['/tmp/first', '/tmp/second']
    const request = { requestId: requestId('dirs-idempotent'), actor: agentTeamHumanActor(), workspaceId,
      channelRef: test.channelRef, workingDirectories: configured }
    expect(applied(await test.ledger.updateChannelWorkingDirectories(request)).workingDirectories).toEqual(configured)
    expect((await test.ledger.updateChannelWorkingDirectories(request)).committed).toBe(false)
    await expect(test.ledger.updateChannelWorkingDirectories({ ...request, workingDirectories: [...configured].reverse() }))
      .rejects.toThrow(/request id/)
    await expect(test.ledger.updateChannelWorkingDirectories({ ...request, requestId: requestId('dirs-empty'), workingDirectories: [] }))
      .rejects.toThrow(/between one and four absolute paths/)
    await expect(test.ledger.updateChannelWorkingDirectories({ ...request, requestId: requestId('dirs-too-many'), workingDirectories: ['/a', '/b', '/c', '/d', '/e'] }))
      .rejects.toThrow(/between one and four absolute paths/)
    await expect(test.ledger.updateChannelWorkingDirectories({ ...request, requestId: requestId('dirs-relative'), workingDirectories: ['relative/path'] }))
      .rejects.toThrow(/non-empty absolute path/)
    await expect(test.ledger.updateChannelWorkingDirectories({ ...request, requestId: requestId('dirs-nul'), workingDirectories: ['/tmp/bad\u0000path'] }))
      .rejects.toThrow(/non-empty absolute path/)
  })
})

describe('Member work-domain bindings', () => {
  it('keeps a legacy Member Session out of domain bindings and binds the Channel Session explicitly', async () => {
    const test = await fixture()
    // Legacy Member Session data is retained for migration, but never exposed
    // as an active work-domain binding.
    expect(test.ledger.memberScopeSessions(test.memberId)).toEqual([])
    expect(test.ledger.getMember(test.memberId)?.sessionId).toBe(SessionId('session:scoped-default'))

    const scopeKey = channelMemberScopeKey(test.channelRef)
    const bound = applied(await bind(test, scopeKey, SessionId('session:scoped-thread'))).binding
    expect(bound).toEqual({ scopeKey, scopeKind: 'channel', scopeRef: test.channelRef, sessionId: SessionId('session:scoped-thread'), workingDirectories: [workspaceRoot] })

    // The Member's legacy field stays unchanged; only the Channel binding is current.
    expect(test.ledger.getMember(test.memberId)?.sessionId).toBe(SessionId('session:scoped-default'))
    expect(test.ledger.memberScopeSessions(test.memberId).map(binding => binding.sessionId))
      .toEqual([SessionId('session:scoped-thread')])
    expect(test.ledger.memberScopeSessionFor(test.memberId, scopeKey)?.sessionId).toBe(SessionId('session:scoped-thread'))

    // A retry resolves the recorded binding rather than writing a second one.
    const retried = await bind(test, scopeKey, SessionId('session:scoped-thread'))
    expect(retried.committed, 'the retry writes nothing').toBe(false)
  })

  it('cold reopen: a bound domain round-trips the durable schema and replay', async () => {
    const test = await fixture()
    const scopeKey = channelMemberScopeKey(test.channelRef)
    await bind(test, scopeKey, SessionId('session:scoped-thread'))

    // The Host's own mount path: a fresh ledger over the same records, with the
    // sequential replay validation applied. A binding whose shape disagrees with
    // its key, or a namespace the schema does not know, fails right here.
    const cold = await restart(test)
    expect(cold.memberScopeSessionFor(test.memberId, scopeKey)).toEqual({
      scopeKey, scopeKind: 'channel', scopeRef: test.channelRef, sessionId: SessionId('session:scoped-thread'), workingDirectories: [workspaceRoot],
    })
    // Replaying the same records twice is idempotent.
    await restart(test)
  })

  it('cold reopen: accepts a binding recorded before workspaceId and directory snapshots existed', async () => {
    const test = await fixture()
    const scopeKey = channelMemberScopeKey(test.channelRef)
    await bind(test, scopeKey, SessionId('session:legacy-thread'))

    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([key, operation]) => {
      const stored = operation as AgentTeamOperation
      if (stored.kind !== 'team/member-scope-session-bound') return [key, stored] as [string, unknown]
      const { memberId, binding: recorded } = stored.data
      return [key, {
        ...stored,
        data: {
          memberId,
          binding: {
            scopeKey: recorded.scopeKey,
            scopeKind: recorded.scopeKind,
            ...(recorded.scopeRef === undefined ? {} : { scopeRef: recorded.scopeRef }),
            sessionId: recorded.sessionId,
          },
        },
      } satisfies AgentTeamOperation] as [string, unknown]
    })

    const cold = await reopen(records)
    expect(cold.memberScopeSessionFor(test.memberId, scopeKey)).toEqual({
      scopeKey, scopeKind: 'channel', scopeRef: test.channelRef, sessionId: SessionId('session:legacy-thread'),
    })
  })

  it('keeps a discussion in one domain across promoteThread', async () => {
    const test = await fixture()
    const scopeKey = channelMemberScopeKey(test.channelRef)
    await bind(test, scopeKey, SessionId('session:scoped-thread'))
    const before = test.ledger.memberScopeSessions(test.memberId)

    // The discussion gains a Task in place. The Task is the domain's overlay,
    // never its identity: the binding must not move and no second domain appears.
    applied(await test.ledger.promoteThread({ requestId: requestId('promote'), workspaceId, threadRef: test.threadRef,
      baseRevision: test.revision, actor: agentTeamHumanActor() }))

    expect(test.ledger.memberScopeSessions(test.memberId)).toEqual(before)
    expect(test.ledger.memberScopeSessionFor(test.memberId, scopeKey)?.sessionId).toBe(SessionId('session:scoped-thread'))
    expect(test.ledger.memberScopeSessionFor(test.memberId, channelMemberScopeKey(test.otherChannelRef))).toBeUndefined()
    await restart(test)
  })

  it('refuses a binding that would give one Session two domains, or bind the default domain twice', async () => {
    const test = await fixture()
    const scopeKey = channelMemberScopeKey(test.channelRef)
    await bind(test, scopeKey, SessionId('session:scoped-thread'))

    // The default domain IS the Member's own Session.
    await expect(bind(test, DEFAULT_MEMBER_SCOPE_KEY, SessionId('session:scoped-default'))).rejects.toThrow(/default Member scope is the Member Session itself/)
    // One Session holds one context: two domains must never share it.
    await expect(test.ledger.bindMemberScopeSession({ requestId: requestId('alias'), workspaceId, memberId: test.memberId,
      binding: { scopeKey: channelMemberScopeKey(test.otherChannelRef), scopeKind: 'channel', scopeRef: test.otherChannelRef,
        sessionId: SessionId('session:scoped-thread') }, actor: agentTeamHumanActor() })).rejects.toThrow(/invalid Member scope binding/)
    // Nor may a domain alias the Member's default Session: that is no isolation.
    await expect(test.ledger.bindMemberScopeSession({ requestId: requestId('alias-default'), workspaceId, memberId: test.memberId,
      binding: { scopeKey: channelMemberScopeKey(test.otherChannelRef), scopeKind: 'channel', scopeRef: test.otherChannelRef,
        sessionId: SessionId('session:scoped-default') }, actor: agentTeamHumanActor() })).rejects.toThrow(/invalid Member scope binding/)
    // A domain is bound once; only a Session transition moves it afterwards.
    await expect(test.ledger.bindMemberScopeSession({ requestId: requestId('rebind'), workspaceId, memberId: test.memberId,
      binding: { scopeKey, scopeKind: 'channel', scopeRef: test.channelRef, sessionId: SessionId('session:scoped-other') },
      actor: agentTeamHumanActor() })).rejects.toThrow(/invalid Member scope binding/)
    // A domain for a ref this ledger never recorded is state no reader can resolve.
    await expect(test.ledger.bindMemberScopeSession({ requestId: requestId('unknown-ref'), workspaceId, memberId: test.memberId,
      binding: { scopeKey: channelMemberScopeKey('channel:missing' as AgentTeamChannelRef), scopeKind: 'channel',
        scopeRef: 'channel:missing' as AgentTeamChannelRef, sessionId: SessionId('session:scoped-missing') },
      actor: agentTeamHumanActor() })).rejects.toThrow(/names unknown Channel/)
  })

  it('transitions one domain onto a new Session without touching the Member row', async () => {
    const test = await fixture()
    const scopeKey = channelMemberScopeKey(test.channelRef)
    await bind(test, scopeKey, SessionId('session:scoped-thread'))

    applied(await test.ledger.renewMemberSession({ requestId: requestId('renew-scope'), actor: agentTeamHumanActor(), workspaceId,
      memberId: test.memberId, sessionId: SessionId('session:scoped-thread-next'), scopeKey }))

    expect(test.ledger.getMember(test.memberId)?.sessionId, 'the default domain keeps its Session').toBe(SessionId('session:scoped-default'))
    expect(test.ledger.memberScopeSessionFor(test.memberId, scopeKey)?.sessionId).toBe(SessionId('session:scoped-thread-next'))
    expect(test.ledger.memberScopeSessionFor(test.memberId, scopeKey)?.workingDirectories).toEqual([workspaceRoot])
    expect(test.ledger.previousSessionForMember(test.memberId, scopeKey)).toBe(SessionId('session:scoped-thread'))
    expect(test.ledger.lastTransitionForMember(test.memberId, scopeKey)).toEqual({
      previousSessionId: SessionId('session:scoped-thread'), targetSessionId: SessionId('session:scoped-thread-next'),
    })
    expect(test.ledger.previousSessionForMember(test.memberId), 'the default domain records no transition').toBeUndefined()

    // A scoped transition is durable state: the reopen reproduces both domains.
    const cold = await restart(test)
    expect(cold.memberScopeSessionFor(test.memberId, scopeKey)?.sessionId).toBe(SessionId('session:scoped-thread-next'))
    expect(cold.memberScopeSessionFor(test.memberId, scopeKey)?.workingDirectories).toEqual([workspaceRoot])
    expect(cold.getMember(test.memberId)?.sessionId).toBe(SessionId('session:scoped-default'))
  })

  it('rejects a scoped transition on a domain that holds no Session', async () => {
    const test = await fixture()
    await expect(test.ledger.renewMemberSession({ requestId: requestId('renew-unbound'), actor: agentTeamHumanActor(), workspaceId,
      memberId: test.memberId, sessionId: SessionId('session:nowhere'), scopeKey: channelMemberScopeKey(test.channelRef) }))
      .rejects.toThrow(/holds no Session for work domain/)
    // A domain the ledger cannot parse is refused before any record lands.
    await expect(test.ledger.renewMemberSession({ requestId: requestId('renew-bad-key'), actor: agentTeamHumanActor(), workspaceId,
      memberId: test.memberId, sessionId: SessionId('session:nowhere'), scopeKey: 'task:task:abc' as AgentTeamMemberScopeKey }))
      .rejects.toThrow(/holds no Session for work domain/)
    // The key's namespace is the binding path's business: a key this module
    // never wrote is refused there, by the same parser replay uses.
    await expect(test.ledger.bindMemberScopeSession({ requestId: requestId('bind-bad-key'), workspaceId, memberId: test.memberId,
      binding: { scopeKey: 'task:task:abc' as AgentTeamMemberScopeKey, scopeKind: 'channel', scopeRef: 'task:abc',
        sessionId: SessionId('session:nowhere') }, actor: agentTeamHumanActor() }))
      .rejects.toThrow(/unknown scope kind 'task'/)
  })
})

describe('A Member row that still carries a Session of its own', () => {
  /**
   * Legacy Member rows still carry `sessionId` in the strict durable schema,
   * but reopening them must not recreate a default work-domain binding.
   */
  it('cold reopen: admits a legacy Member sessionId without restoring a default domain', async () => {
    const test = await fixture()
    const scopeKey = channelMemberScopeKey(test.channelRef)
    await bind(test, scopeKey, SessionId('session:scoped-thread'))

    const cold = await reopen([...test.facility.get('agent_team')!.table('operations').entries()])

    // The durable row remains readable, but only the explicit Channel binding
    // is a work domain; the old Member Session is not reattached.
    expect(cold.getMember(test.memberId)?.memberId).toBe(test.memberId)
    expect(cold.memberScopeSessions(test.memberId).map(binding => binding.scopeKey)).toEqual([scopeKey])
    expect(cold.memberScopeSessionFor(test.memberId, DEFAULT_MEMBER_SCOPE_KEY)).toBeUndefined()
  })
})
