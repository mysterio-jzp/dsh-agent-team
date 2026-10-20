import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  decideMemberRoute,
  installMemberModelRoute,
  sessionModelChoice,
  updateMemberModelRoute,
  type MemberModelRouteInput,
  type MemberRouteSource,
} from '../src/member-model-route.ts'

/**
 * The Host unit this route reads: the Session controller's `modelSelection`
 * fold, reduced to the two states the route distinguishes. The real unit lives
 * in the Harness Session controller, which a plugin test cannot load, so this
 * mirrors its contract — a pick sets `pending`, and a request whose logged route
 * equals it consumes it into `lastUsed`. Its key belongs to the Host Session
 * controller, which this package does not compile against, so it is registered
 * through the registry's own signature rather than the local projection map.
 */
const modelSelectionProjection = {
  key: 'modelSelection',
  init: () => ({ lastUsed: null as ModelSelection | null, pending: null as ModelSelection | null }),
  apply: (state: { lastUsed: ModelSelection | null; pending: ModelSelection | null }, event: { type: string; data: unknown }) => {
    if (event.type === 'model/selection') return { lastUsed: state.lastUsed, pending: event.data as ModelSelection }
    if (event.type !== 'request/header') return state
    const data = event.data as { header: { config: ModelSelection } }
    const logged: ModelSelection = {
      provider: data.header.config.provider,
      model: data.header.config.model,
      ...data.header.config.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: data.header.config.reasoningEffort },
    }
    const same = (left: ModelSelection | null): boolean => left !== null
      && left.provider === logged.provider
      && left.model === logged.model
      && left.reasoningEffort === logged.reasoningEffort
    return { lastUsed: logged, pending: same(state.pending) ? null : state.pending }
  },
  stateVersion: 1,
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

const route = (model: string, provider = 'p'): ModelSelection => ({ provider, model })

interface Fixture {
  readonly ctx: Context
  readonly agent: Agent
  readonly input: (override: ModelSelection | undefined, hostDefault?: ModelSelection) => MemberModelRouteInput
  /**
   * Simulate the one configuration edit that can retire a Session pick: a
   * change to the configured model itself. Every other Member field is covered
   * by the description-edit reading below, which must NOT retire it.
   */
  /** Log what the Session's next request will be compared against. */
  readonly logRequest: (selection: ModelSelection) => void
  /** A Human pick, as the Session controller records one. */
  readonly pick: (selection: ModelSelection) => void
  /** Move the Member's configuration version, as a Member edit does. */
  readonly editMemberConfig: () => void
}

async function fixture(id = 'session:route'): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  ctx.effect(
    () => ctx.sessionProjections.register(modelSelectionProjection as never),
    'test.modelSelection',
  )
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const session = Session.create(SessionId(id))
  // The route only reads `agent.session` and `agent.ctx`; the Agent facade's
  // other members never enter the decision.
  const agent = { session, ctx } as unknown as Agent
  return {
    ctx,
    agent,
    input: (override, hostDefault = route('default')) => ({
      ctx,
      agent,
      override,
      hostDefault: () => hostDefault,
    }),
    logRequest: selection => { session.append('request/header', { header: { config: selection }, reason: 'change' }) },
    // The event type is declared by the Host Session controller, which this
    // package does not compile against, so the append is typed locally.
    pick: selection => {
      const event = session.append('model/selection', selection)
      // This bare Session has no SessionStore publication hook.
      ctx.emit('session/event', session, event)
    },
    editMemberConfig: () => {},
  }
}

const initial: MemberRouteSource = { kind: 'member' }

describe('member model route', () => {
  it('reads the Session projection and survives a Host without one', async () => {
    const live = await fixture()
    live.pick(route('chosen'))
    expect(sessionModelChoice(live.ctx, live.agent)).toEqual({ pending: route('chosen'), lastUsed: undefined })

    const bare = new Context()
    cleanups.push(async () => { await bare.fiber.dispose() })
    const bareAgent = { session: Session.create(SessionId('session:bare')), ctx: bare } as unknown as Agent
    expect(sessionModelChoice(bare, bareAgent)).toEqual({ pending: undefined, lastUsed: undefined })

    // Arm 5: a Host with no projection must not throw; it routes on configuration.
    expect(decideMemberRoute(
      { ctx: bare, agent: bareAgent, override: route('override'), hostDefault: () => route('default') },
      undefined,
      initial,
    ).selection).toEqual(route('override'))
  })

  it('follows a Human pick on the next request and keeps it afterwards', async () => {
    const live = await fixture()
    live.logRequest(route('override'))
    expect(decideMemberRoute(live.input(route('override')), undefined, initial).selection).toEqual(route('override'))

    // Arm 1/2: a pick wins the request that consumes it, and is recorded.
    live.pick(route('chosen'))
    const switched = decideMemberRoute(live.input(route('override')), undefined, initial)
    expect(switched.selection).toEqual(route('chosen'))
    expect(switched.source.kind).toBe('session')

    // The request goes out with it, consuming the pending value...
    live.logRequest(route('chosen'))
    expect(sessionModelChoice(live.ctx, live.agent).pending).toBeUndefined()

    // ...and the Session keeps winning while the Member is not edited.
    expect(decideMemberRoute(live.input(route('override')), undefined, switched.source).selection).toEqual(route('chosen'))
  })

  it('lets a later Member edit take over, and a later pick take it back', async () => {
    const live = await fixture()
    live.logRequest(route('first'))
    // The pick is decided as soon as it is made, and that decision is what the
    // route records — the request that follows consumes the pending value.
    live.pick(route('chosen'))
    const picked = decideMemberRoute(live.input(route('first')), undefined, initial)
    expect(picked.selection).toEqual(route('chosen'))
    expect(picked.source.kind).toBe('session')
    live.logRequest(route('chosen'))

    // The Human then edits the Member's configuration to a different model: the
    // last action wins.
    live.editMemberConfig()
    const edited = decideMemberRoute(live.input(route('second')), undefined, picked.source)
    expect(edited.selection).toEqual(route('second'))
    expect(edited.source.kind).toBe('member')

    // A new selection event takes it back; the installed route owns this
    // transition, including clearing the cutoff for an older rejected pick.
    const installed = installMemberModelRoute(() => live.input(route('second')), undefined, edited.source)
    cleanups.push(async () => { installed.dispose() })
    live.pick(route('third'))
    expect(installed.ref.current).toEqual(route('third'))
  })

  it('follows the Host default when nobody configured anything', async () => {
    const live = await fixture()
    expect(decideMemberRoute(live.input(undefined, route('old-default')), undefined, initial).selection)
      .toEqual(route('old-default'))
    // No pick and no edit: the CURRENT default applies, not a pinned older one.
    expect(decideMemberRoute(live.input(undefined, route('new-default')), undefined, initial).selection)
      .toEqual(route('new-default'))
  })

  it('starts a fresh Session from the Member configuration', async () => {
    const live = await fixture()
    live.pick(route('chosen'))
    live.logRequest(route('chosen'))

    const fresh = await fixture('session:fresh')
    // A new Session gets no marker or choice from the previous generation.
    const installed = installMemberModelRoute(() => fresh.input(route('override')))
    cleanups.push(async () => { installed.dispose() })
    expect(installed.ref.current).toEqual(route('override'))
    expect(installed.source().kind).toBe('member')
  })

  it('carries a Member edit to every live domain, not just the default one', async () => {
    // A Member can hold several work domains at once, each with its own Session.
    const domains = await Promise.all([fixture('session:domain-default'), fixture('session:domain-thread')])
    const routes = domains.map(domain => installMemberModelRoute(() => domain.input(route('configured'))))
    cleanups.push(async () => { for (const installed of routes) installed.dispose() })
    for (const installed of routes) expect(installed.ref.current).toEqual(route('configured'))

    // The Human edits the Member's config: every domain's route must follow,
    // not only whichever Session happens to be the Member's default.
    const surfaces = domains.map((domain, index) => ({
      agent: domain.agent,
      input: () => domain.input(route(`edited-${index}`)),
    }))
    routes.forEach((installed, index) => {
      updateMemberModelRoute(installed, surfaces[index]!.input)
      expect(installed.ref.current).toEqual(route(`edited-${index}`))
    })
  })

  it('keeps a Session pick that equals the Member configuration', async () => {
    const live = await fixture()
    live.logRequest(route('first'))
    // The Human picks B in the Session...
    live.pick(route('same'))
    const picked = decideMemberRoute(live.input(route('other')), undefined, initial)
    expect(picked.selection).toEqual(route('same'))
    expect(picked.source.kind).toBe('session')
    live.logRequest(route('same'))

    // ...and also sets the Member config to that same B. The two sides now agree,
    // so the value alone cannot say who wrote last — the recorded versions must.
    live.editMemberConfig()
    const edited = decideMemberRoute(live.input(route('same')), undefined, picked.source)
    // The Member edit is the later action, and it took over: the route follows it
    // and says so, rather than reading as "the Session still owns this".
    expect(edited.selection).toEqual(route('same'))
    expect(edited.source.kind).toBe('member')

    // Changing the Host default afterwards must not be mistaken for a Member edit:
    // the Member source stays in force and the Session keeps B.
    expect(decideMemberRoute(live.input(route('same'), route('new-default')), undefined, edited.source).selection)
      .toEqual(route('same'))
  })

  it('keeps a Session pick when only a non-model Member field is edited', async () => {
    const live = await fixture()
    live.logRequest(route('first'))
    live.pick(route('chosen'))
    const picked = decideMemberRoute(live.input(route('other')), undefined, initial)
    expect(picked.selection).toEqual(route('chosen'))
    live.logRequest(route('chosen'))

    // The Human edits the Member's description (or any non-model field): the
    // configured model is unchanged, so the Session's pick still governs. This
    // is the case a ledger-sequence comparison got wrong.
    const afterDescriptionEdit = decideMemberRoute(live.input(route('other')), undefined, picked.source)
    expect(afterDescriptionEdit.selection).toEqual(route('chosen'))
    expect(afterDescriptionEdit.source.kind).toBe('session')

    // A genuine model change still takes over.
    expect(decideMemberRoute(live.input(route('other-changed')), undefined, afterDescriptionEdit.source).selection)
      .toEqual(route('other-changed'))
  })

  it('treats an effort-only Member edit as a new model action', async () => {
    const live = await fixture()
    live.logRequest(route('first'))
    live.pick(route('chosen'))
    const picked = decideMemberRoute(live.input(route('chosen')), undefined, initial)
    expect(picked.selection).toEqual(route('chosen'))
    live.logRequest(route('chosen'))

    // Provider and model stay put and only the effort moves: that is still a new
    // model decision on the Member side, so the Session pick must give way. The
    // two co-changing fields are what make this easy to miss in an implementation.
    const high = { ...route('chosen'), reasoningEffort: ReasoningEffortId('high') }
    const edited = decideMemberRoute(live.input(high), undefined, picked.source)
    expect(edited.selection).toEqual(high)
    expect(edited.source.kind).toBe('member')

    // And an edit that leaves all three alone is not a model action.
    expect(decideMemberRoute(live.input(high), undefined, edited.source).source.kind).toBe('member')
  })

  it('keeps the effort a Member configured', async () => {
    const live = await fixture()
    const installed = installMemberModelRoute(
      () => live.input({ provider: 'p', model: 'override', reasoningEffort: ReasoningEffortId('high') }),
    )
    cleanups.push(async () => { installed.dispose() })
    expect(installed.ref.current).toEqual({ provider: 'p', model: 'override', reasoningEffort: ReasoningEffortId('high') })
  })
})
