/**
 * One Member Session's route. Session intent remains in the Host projection;
 * the Team ledger records which action governs this exact Session and which
 * Member model revision it observed. Neither log's sequence is compared with
 * the other log's sequence.
 * @module @contexera/dsh-agent-team/member-model-route
 */
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { AgentTeamMemberRouteSource } from './types/entities.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'

interface SessionModelProjectionState {
  readonly lastUsed?: ModelSelection | null
  readonly pending?: ModelSelection | null
}

/** The pending Human pick and the route the last request consumed. */
export interface SessionModelChoice {
  readonly pending: ModelSelection | undefined
  readonly lastUsed: ModelSelection | undefined
}

/** Governing action, persisted per Session rather than shared between domains. */
export type MemberRouteSource = AgentTeamMemberRouteSource

/** Only these three configured fields constitute a model edit. */
export interface MemberModelSnapshot {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** A genuinely fresh Session follows the Member configuration. */
export const INITIAL_ROUTE_SOURCE: MemberRouteSource = Object.freeze({ kind: 'member' })

function sameModel(left: MemberModelSnapshot | undefined, right: MemberModelSnapshot | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort)
}

function selectionOf(value: ModelSelection | null | undefined): ModelSelection | undefined {
  if (value === null || value === undefined) return undefined
  return { provider: value.provider, model: value.model,
    ...value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort } }
}

/**
 * Read the Host's authoritative selection projection, when mounted.
 * @param ctx - Agent context holding the projection registry.
 * @param agent - Member Agent whose Session is read.
 * @returns pending and last-used routes, absent on a Host without a controller.
 */
export function sessionModelChoice(ctx: Context, agent: Agent): SessionModelChoice {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) return { pending: undefined, lastUsed: undefined }
  const state = projections.stateOf(agent.session, 'modelSelection' as never) as SessionModelProjectionState | undefined
  return { pending: selectionOf(state?.pending), lastUsed: selectionOf(state?.lastUsed) }
}

/** Live route state for one Member Session. */
export interface MemberModelRoute {
  readonly ref: ModelSelectionRef
  source(): MemberRouteSource
  dispose(): void
}

/** Fresh decision inputs; Member configuration is never captured at activation. */
export interface MemberModelRouteInput {
  readonly ctx: Context
  readonly agent: Agent
  readonly override: ModelSelection | undefined
  /** Last actual Member model edit; unrelated edits leave this unchanged. */
  readonly memberModelVersion?: number
  readonly hostDefault: () => ModelSelection
}

/**
 * Resolve a pending pick, a consumed pick, or the Member/default route.
 * @param input - live Session and Member configuration.
 * @param established - activation fallback when no Member override exists.
 * @param source - last recorded governing action for this Session.
 * @returns selected route and the action governing it.
 */
export function decideMemberRoute(
  input: MemberModelRouteInput,
  established: ModelSelection | undefined,
  source: MemberRouteSource,
): { readonly selection: ModelSelection; readonly source: MemberRouteSource } {
  const choice = sessionModelChoice(input.ctx, input.agent)
  const configured = selectionOf(input.override)
  const unchanged = sameModel(configured, source.memberModel) && input.memberModelVersion === source.memberModelVersion
  const member = {
    ...configured === undefined ? {} : { memberModel: configured },
    ...input.memberModelVersion === undefined ? {} : { memberModelVersion: input.memberModelVersion },
  }
  // A recorded pick whose Member model revision changed is older than that
  // edit, even if no request consumed it before suspension. Retain its cutoff
  // until a new selection event resets the runtime marker.
  const superseded = source.memberModelVersion !== undefined && input.memberModelVersion !== source.memberModelVersion
  const suppressed = superseded || (source.kind === 'member' && source.sessionVersion !== undefined)
  if (choice.pending !== undefined && !suppressed) {
    return { selection: choice.pending, source: {
      kind: 'session',
      sessionVersion: source.kind === 'session' && unchanged
        ? source.sessionVersion ?? Number(input.agent.session.seq) : Number(input.agent.session.seq),
      ...member,
    } }
  }
  if (source.kind === 'session' && choice.lastUsed !== undefined && unchanged) {
    return { selection: choice.lastUsed, source: { ...source, ...member } }
  }
  return {
    selection: selectionOf(input.override) ?? selectionOf(established) ?? { ...input.hostDefault() },
    source: { kind: 'member', ...source.sessionVersion === undefined ? {} : { sessionVersion: source.sessionVersion }, ...member },
  }
}

/**
 * Install routing and persist Session choices before a request consumes them.
 * @param input - live decision inputs.
 * @param established - activation fallback.
 * @param source - ledger marker for this exact Session, absent for a fresh one.
 * @param persist - Team-owned durable acknowledgement; failures block the next request.
 * @returns route ref and scoped-listener disposer.
 */
export function installMemberModelRoute(
  input: () => MemberModelRouteInput,
  established?: ModelSelection,
  source: MemberRouteSource = INITIAL_ROUTE_SOURCE,
  persist?: (source: MemberRouteSource) => Promise<void>,
): MemberModelRoute {
  let current = source
  const decide = (): ModelSelection => {
    const decided = decideMemberRoute(input(), established, current)
    current = decided.source
    return decided.selection
  }
  const record = (): Promise<void> => current.kind === 'session' && persist !== undefined
    ? persist(current) : Promise.resolve()
  const observe = (): void => {
    void record().catch(error => input().ctx.logger.warn('Member model route persistence failed: %s', String(error)))
  }
  const ref: ModelSelectionRef = { current: decide(), assembled: undefined }
  const disposeSelection = installModelSelection(input().agent.ctx, ref)
  // Recording pending intent at installation also covers a pick made before the
  // Agent was resumed. The pre-step awaits/retries the same idempotent write.
  observe()
  const disposeEvent = input().agent.ctx.on('session/event', (session, event) => {
    if (session !== input().agent.session) return
    if (event.type !== 'model/selection' && event.type !== 'request/header') return
    if (event.type === 'model/selection') current = INITIAL_ROUTE_SOURCE
    const decided = decide()
    if (!sameModel(ref.current, decided)) ref.current = decided
    if (event.type === 'model/selection') observe()
  })
  const disposeStep = input().agent.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    const decided = decide()
    if (!sameModel(ref.current, decided)) ref.current = decided
    await record()
    return decision
  })
  return { ref, source: () => current, dispose: () => {
    disposeStep()
    disposeEvent()
    disposeSelection()
  } }
}

/**
 * Refresh every live domain after a Member model edit.
 * @param route - installed Session route.
 * @param input - fresh Member configuration.
 * @param established - activation fallback.
 */
export function updateMemberModelRoute(
  route: MemberModelRoute,
  input: () => MemberModelRouteInput,
  established?: ModelSelection,
): void {
  route.ref.current = decideMemberRoute(input(), established, route.source()).selection
}

/** Session-local log offset, never compared with a Team ledger sequence. */
export type RouteSessionVersion = SessionSeq
