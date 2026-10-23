/**
 * The Agent Team's binding of the context-continuity engine: how one Member
 * resolves to its live Agent and back, how a Member Session's fold state is
 * read, how a prepared generation swap runs in the Member lifecycle, and the
 * two domain dimensions the engine refuses to own (which queued messages are
 * Team notices, and how a rollover's durable identity is named).
 *
 * The engine owns every mechanic this module does not state: the idle-boundary
 * swap, carried input, checkpoint continuations, crash repair, and the
 * context-pressure policy itself. Team owns the Member vocabulary and the
 * ledger-backed lifecycle behind
 * {@link TeamContextContinuityOptions.executeTransition}, and the per-Member
 * readings the pressure policy asks for.
 *
 * The projection state this host hands the coordinator is the engine's own
 * (`ContextProjectionState`), read from the unit `context-projection.ts`
 * registers once per Host — one state shape, one fold, no translation.
 * @module @contexera/dsh-agent-team/context-continuity-host
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import {
  ContextContinuityCoordinator,
  ContextMessageCodec,
  ContextPressurePolicy,
  DEFAULT_GATE_IDLE_MS,
  DEFAULT_GATE_JUDGE_TIMEOUT_MS,
  DEFAULT_GATE_TOKENS,
  type ContextContinuityHost,
  type ContextProjectionState,
  type ContextSubject,
  type PressureCompaction,
  type PressureGate,
  type PressureInHand,
  type PressureJudgement,
  type PressureLimits,
  type PressureLogSpan,
  type PressureNoticeText,
  type PressurePolicyHost,
  type PressureRelatedness,
  type PressureStepDecision,
  type PressureSurface,
  type RolloverIdentity,
  type TransitionPlan,
} from '@contexera/dsh-context-continuity'
import { SessionId as SessionIdBrand } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { AGENT_TEAM_PLUGIN_ID, isAgentTeamSource } from './context-source.ts'
import type { AgentTeamAgentMember, AgentTeamMemberId, AgentTeamMemberScopeKey, AgentTeamRolloverSessionRequest } from './types.ts'

/**
 * The one writer of context-continuity messages for Team. Section names are
 * the engine's fixed vocabulary; only the plugin identity and the two
 * subject-facing prose lines are Team's, and both are frozen by history —
 * durable logs written by earlier generations are read back through this same
 * identity, so `handoffIntro` and `handoffVerifyNote` reproduce them byte for
 * byte.
 */
export const TEAM_CONTEXT_CODEC = new ContextMessageCodec({
  pluginId: AGENT_TEAM_PLUGIN_ID,
  handoffIntro: 'Context handoff: you are continuing as the same Team Member in a fresh private context.',
  handoffVerifyNote: 'Your handoff from the previous context follows. Verify external state before relying on it; a context change never rolls back files, processes, Team facts, or remote side effects.',
})

export interface TeamContextContinuityOptions {
  /**
   * Resolve the live Agent of one Member in one work domain; undefined leaves
   * intent parked. A Member owns no Session of its own, so a domain is always
   * named explicitly and there is nothing to drift back to.
   */
  readonly agentForMember: (memberId: AgentTeamMemberId, scopeKey: AgentTeamMemberScopeKey) => Agent | undefined
  /**
   * Resolve the durable Member of one live Agent, and the work domain it runs.
   * `default` names no domain any more, so the pair travels together instead of
   * being read off the Member row.
   */
  readonly surfaceForAgent: (agent: Agent) => { readonly member: AgentTeamAgentMember, readonly scopeKey: AgentTeamMemberScopeKey } | undefined
  /** Resolve the durable Member of one live Agent. */
  readonly memberForAgent: (agent: Agent) => AgentTeamAgentMember | undefined
  /** The Session running one Member's work domain, or undefined when it holds none. */
  readonly sessionForMemberScope: (memberId: AgentTeamMemberId, scopeKey: AgentTeamMemberScopeKey) => SessionId | undefined
  /** Every work domain one Member holds a Session for; `default` is never among them. */
  readonly scopesForMember: (memberId: AgentTeamMemberId) => readonly AgentTeamMemberScopeKey[]
  /**
   * Read one Member Session's engine-folded continuity state: the unit
   * registered by `context-projection.ts`, or undefined when the Member has no
   * live Session with that id (the coordinator leaves intent parked).
   */
  readonly projectionForMember: (memberId: AgentTeamMemberId, sessionId: SessionId) => ContextProjectionState | undefined
  /**
   * Execute one prepared Member generation swap at a true idle boundary:
   * commit, dispose, archive, create/activate, deliver the handoff first,
   * then carried input and the rederived Inbox. Returns once the Member runs
   * its new generation.
   */
  readonly executeTransition: (memberId: AgentTeamMemberId, plan: TransitionPlan) => Promise<void>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
}

/**
 * Team's `ContextContinuityHost`. Every method is a straight delegation except
 * the three that decide domain meaning: the durable rollover identity, which
 * queued messages are rederived Team notices, and the projection bridge.
 */
export class TeamContextContinuityHost implements ContextContinuityHost<AgentTeamMemberId> {
  /**
   * Last work domain whose live Agent or Session was inspected for a Member.
   * When a Member runs more than one domain (`default` plus `channel:<ref>`),
   * `agentForSubject(memberId)` returns the domain currently driving a
   * continuity decision before falling back to any running domain.
   */
  private readonly activeScopeByMember = new Map<AgentTeamMemberId, AgentTeamMemberScopeKey>()

  constructor(private readonly options: TeamContextContinuityOptions) {}

  /**
   * The Agent of one Member, resolved through the domain currently under
   * continuity evaluation (or any domain that Member actually runs). The
   * engine's subject vocabulary names the Member id without a domain key;
   * tracking the last inspected domain ensures multi-domain Members resolve
   * the same domain that emitted the checkpoint or rollover event.
   */
  agentForSubject(memberId: AgentTeamMemberId): Agent | undefined {
    const scopes = this.options.scopesForMember(memberId)
    const activeScope = this.activeScopeByMember.get(memberId)
    if (activeScope !== undefined && scopes.includes(activeScope)) {
      const activeAgent = this.options.agentForMember(memberId, activeScope)
      if (activeAgent !== undefined) return activeAgent
    }
    for (const scopeKey of scopes) {
      const agent = this.options.agentForMember(memberId, scopeKey)
      if (agent !== undefined) return agent
    }
    return undefined
  }

  /**
   * The continuity subject of one live Agent: its Member plus the Session of
   * the domain it actually runs. Reading the Member row's `sessionId` here was
   * the last way the retired default domain could re-enter a context decision.
   */
  subjectForAgent(agent: Agent): ContextSubject<AgentTeamMemberId> | undefined {
    const surface = this.options.surfaceForAgent(agent)
    if (surface === undefined) return undefined
    const sessionId = this.options.sessionForMemberScope(surface.member.memberId, surface.scopeKey)
    if (sessionId === undefined) throw new Error(`agent-team: Member '${surface.member.memberId}' runs work domain '${surface.scopeKey}' without a Session`)
    this.activeScopeByMember.set(surface.member.memberId, surface.scopeKey)
    return { id: surface.member.memberId, sessionId }
  }

  projectionForSubject(memberId: AgentTeamMemberId, sessionId: SessionId): ContextProjectionState | undefined {
    for (const scopeKey of this.options.scopesForMember(memberId)) {
      if (this.options.sessionForMemberScope(memberId, scopeKey) === sessionId) {
        this.activeScopeByMember.set(memberId, scopeKey)
        break
      }
    }
    return this.options.projectionForMember(memberId, sessionId)
  }

  executeTransition(memberId: AgentTeamMemberId, plan: TransitionPlan): Promise<void> {
    return this.options.executeTransition(memberId, plan)
  }

  /**
   * Rollover identity, unchanged from the in-repo coordinator: stable key over
   * the previous Session and the successful tool call, JSON-encoded so no
   * delimiter can alias across the two unconstrained fields, then hashed to a
   * fixed-length digest. Both names are durable — in-flight recovery converges
   * on `agent-team-rollover-<digest>`, and the ledger records the request id.
   */
  rolloverIdentity(previousSessionId: SessionId, toolCallId: string): RolloverIdentity {
    const stableKey = createHash('sha256').update(JSON.stringify([previousSessionId, toolCallId])).digest('hex')
    return {
      newSessionId: SessionIdBrand(`agent-team-rollover-${stableKey}`),
      requestId: `agent-team:rollover:${stableKey}` as AgentTeamRolloverSessionRequest['requestId'],
    }
  }

  /**
   * A queued message the successor generation rederives from ledger facts: any
   * Team-attributed message. The engine excludes the handoff and continuation
   * envelopes before consulting this, so the two are ordinary delivered
   * context the next generation keeps.
   */
  isEphemeralNotice(message: UserMessage): boolean {
    return isAgentTeamSource(message.source)
  }

  log(message: string): void {
    this.options.log(message)
  }
}

/** Build the engine coordinator over Team's Member lifecycle. */
export function createTeamContextManagement(options: TeamContextContinuityOptions): ContextContinuityCoordinator<AgentTeamMemberId> {
  return new ContextContinuityCoordinator(new TeamContextContinuityHost(options), TEAM_CONTEXT_CODEC)
}

/**
 * Team's wording for the engine's pressure notice: the two labels name work in
 * Team's own vocabulary, while the numbers, the ordering and the default action
 * stay the engine's. A label is presentation; the notice's substance is not a
 * knob.
 */
const TEAM_PRESSURE_TEXT: PressureNoticeText = {
  inHandLabel: 'Active Claims',
  jobsLabel: 'Owner jobs',
}

/** How many of the generation's earlier user inputs one judgement is given. */
const RECENT_INPUT_LIMIT = 8

/**
 * The budget Team gives the long-gap gate's judge when the row states none.
 *
 * The engine's own default is five seconds, which is sized for a judge beside
 * the Host. A hosted endpoint answers in up to about four seconds, and the gate
 * hands the judge one second less than this deadline, so that default turns a
 * slow-but-working judge into a coin flip — and the deployment that meets this
 * problem is the one least able to diagnose it. Ten seconds leaves room for the
 * slow tail while still bounding the wait on the path that starts a turn. A
 * deployment that wants another number still sets `gate.judgeTimeoutMs`, which
 * stays a row field.
 */
export const TEAM_JUDGE_TIMEOUT_DEFAULT_MS = 10_000

/**
 * The long-gap gate as row configuration: every field is optional, so a
 * deployment states only the thresholds it disagrees with and the engine's own
 * default answers the rest. The three answer different questions — how large a
 * context the gate applies to, what counts as a long gap, and how long one
 * judgement may take before the step proceeds without one — and the last is the
 * one that decides whether a configured judge is ever heard, because a judge
 * whose own budget is longer than this deadline never answers in time.
 *
 * All three are volatile, and the engine is what makes that safe: it reads
 * every field at the step it applies to, never at construction, so a Host that
 * keeps one gate object and refreshes its fields in place changes the policy a
 * running generation is judged by. `judgeTimeoutMs` is the field that needs it
 * most — the deadline a judge can answer within is a property of the endpoint,
 * not of the bundle, and a deployment that discovers its endpoint is slow must
 * be able to raise it without editing a patch layer and restarting.
 */
export const TEAM_PRESSURE_GATE_SCHEMA = z.object({
  tokens: z.natural().volatile().description(`Context size at or above which the long-gap gate may hold a step. Default: ${DEFAULT_GATE_TOKENS}.`),
  idleMs: z.natural().volatile().description(`How long a generation must have been idle for a step to count as a long gap. Default: ${DEFAULT_GATE_IDLE_MS} (30 minutes).`),
  judgeTimeoutMs: z.natural().volatile().description(`How long one relatedness judgement may take before the step proceeds without one. Default: ${TEAM_JUDGE_TIMEOUT_DEFAULT_MS}, not the engine's own ${DEFAULT_GATE_JUDGE_TIMEOUT_MS}.`),
})

export interface TeamPressurePolicyOptions {
  /**
   * Resolve the live Agent of one pressure subject. The subject is the live
   * Session, not the Member: one Member runs one Session per work domain, and
   * the engine's own subject key is what keeps each domain's notice latch,
   * overflow-recovery chain and admission view its own.
   */
  readonly agentForSession: (sessionId: SessionId) => Agent | undefined
  /** The Member one live Session belongs to; absent means the Session is not Team's. */
  readonly memberForSession: (sessionId: SessionId) => AgentTeamMemberId | undefined
  /** Effective budgets for one Member's current route; undefined means unknown. */
  readonly limitsForAgent: (agent: Agent) => PressureLimits | undefined | Promise<PressureLimits | undefined>
  /** The reduction capability in one Member's preset scope, or absent when it mounts none. */
  readonly compactionForAgent: (agent: Agent) => PressureCompaction | undefined
  /** The model-visible active-Claim labels for one Member's notice. */
  readonly activeClaimLabels: (memberId: AgentTeamMemberId) => readonly string[]
  /** The model-visible running-job labels for one Session's notice. */
  readonly runningJobLabels: (sessionId: SessionId) => readonly string[]
  /** The long-gap gate's thresholds; an omitted field keeps the engine's default. */
  readonly gate?: PressureGate | undefined
  /**
   * The relatedness judge in one Session's scope, when the deployment installed
   * one. Absent — the surface itself, or the whole deployment — switches the
   * long-gap gate off; a missing judge is a deployment choice, never a failure.
   */
  readonly judgeForAgent?: ((agent: Agent) => PressureJudgement | undefined) | undefined
  /** Report a blocked request with a recoverable diagnostic. */
  readonly failed: (sessionId: SessionId, diagnostic: string) => void
  /** Log one engine diagnostic, attributable to the Session it names. */
  readonly log: (message: string, sessionId: SessionId) => void
}

/**
 * Team's `PressurePolicyHost`, one subject per live Member Session. Every
 * reading is resolved per Session at call time, because one policy serves every
 * Session this Host runs and each work domain must be judged, latched and
 * reduced on its own context. The readings that need the step's own argument
 * are fed for exactly one policy call — {@link beginStep} to {@link endStep} —
 * so a judgement is never made from a neighbouring Session's messages.
 */
export class TeamPressurePolicyHost implements PressurePolicyHost<SessionId> {
  readonly pluginId = AGENT_TEAM_PLUGIN_ID
  private readonly admitting = new Map<SessionId, readonly UserMessage[]>()

  constructor(private readonly options: TeamPressurePolicyOptions) {}

  /** Record the input one step is admitting: the host's own pre-step argument. */
  beginStep(sessionId: SessionId, messages: readonly UserMessage[]): void {
    this.admitting.set(sessionId, messages)
  }

  /** Forget that input again: the view lives only while its policy call runs. */
  endStep(sessionId: SessionId): void {
    this.admitting.delete(sessionId)
  }

  limitsFor(sessionId: SessionId): PressureLimits | undefined | Promise<PressureLimits | undefined> {
    const agent = this.options.agentForSession(sessionId)
    return agent === undefined ? undefined : this.options.limitsForAgent(agent)
  }

  /**
   * This Session's durable surface, for proving a reduction. Without a live
   * Agent there is nothing to measure; the policy reaches this only for a
   * Session whose limits resolved, which already requires one.
   */
  surfaceFor(sessionId: SessionId): PressureSurface {
    const agent = this.options.agentForSession(sessionId)
    if (agent === undefined) return { generation: 0 }
    const tokens = agent.ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens
    return { generation: agent.session.surface.replaceGeneration, ...(tokens === undefined ? {} : { tokens }) }
  }

  compactionFor(sessionId: SessionId): PressureCompaction | undefined {
    const agent = this.options.agentForSession(sessionId)
    return agent === undefined ? undefined : this.options.compactionForAgent(agent)
  }

  /**
   * This Session's durable log, as the notice latch and the idle gap read it.
   * The engine's contract asks for the span's own events and the inherited count
   * beside them; the `ownEvents()` reader is what states that boundary today.
   */
  logSpanFor(sessionId: SessionId): PressureLogSpan {
    const agent = this.options.agentForSession(sessionId)
    if (agent === undefined) return { sessionId: '', inheritedEventCount: 0, events: [] }
    return { sessionId: agent.session.id, inheritedEventCount: agent.session.inheritedEventCount, events: agent.session.ownEvents() }
  }

  inHandFor(sessionId: SessionId): PressureInHand {
    const memberId = this.options.memberForSession(sessionId)
    return {
      // Durable work belongs to the Member, not to one of its domains: every
      // domain's notice states the same claims, and only the jobs are the
      // surface's own.
      inHand: memberId === undefined ? [] : this.options.activeClaimLabels(memberId),
      jobs: this.options.runningJobLabels(sessionId),
    }
  }

  /**
   * The input this step is admitting, and the generation's earlier user input
   * beside it. Both sides exclude Team's own notices: what the gate judges is
   * what a human sent, and a rederived Team notification is neither the request
   * being held nor evidence of what the request continues.
   */
  relatednessFor(sessionId: SessionId): PressureRelatedness | undefined {
    const agent = this.options.agentForSession(sessionId)
    const admitted = this.admitting.get(sessionId)
    if (agent === undefined || admitted === undefined) return undefined
    const input = externalInputText(admitted)
    if (input.trim().length === 0) return undefined
    return { input, recent: this.recentInput(agent, admitted) }
  }

  /**
   * The generation's earlier human input, oldest first, without the messages
   * this step is admitting: the judge is asked what the arriving request
   * continues, so the arriving request is not also part of its own evidence.
   */
  private recentInput(agent: Agent, admitted: readonly UserMessage[]): readonly string[] {
    const admittedIds = new Set(admitted.map(message => message.id))
    return agent.session.deriveMessages()
      .flatMap(message => message.role === 'user' && !admittedIds.has(message.id) && !isAgentTeamSource(message.source)
        ? [messageText(message)]
        : [])
      .filter(text => text.trim().length > 0)
      .slice(-RECENT_INPUT_LIMIT)
  }

  judgeFor(sessionId: SessionId): PressureJudgement | undefined {
    const resolve = this.options.judgeForAgent
    const agent = this.options.agentForSession(sessionId)
    if (resolve === undefined || agent === undefined) return undefined
    return resolve(agent)
  }

  /**
   * Steer one notice into this Session's running turn. A Session with no live
   * Agent throws rather than reporting success: the caller holds a step on the
   * strength of this call, and a held step whose instruction never arrived
   * would stall the surface behind a message that does not exist.
   */
  steer(sessionId: SessionId, notice: UserMessage): void {
    const agent = this.options.agentForSession(sessionId)
    if (agent === undefined) throw new Error('the Session has no live Agent to steer the notice into')
    agent.steer(notice)
  }

  failedFor(sessionId: SessionId, diagnostic: string): void {
    this.options.failed(sessionId, diagnostic)
  }

  log(message: string, sessionId: SessionId): void {
    this.options.log(message, sessionId)
  }
}

/**
 * The engine's context-pressure policy over Team's Member lifecycle: the one
 * place the two sides meet. It owns no decision of its own — the ordering, the
 * notice latch, the fail-closed reduction proof and the long-gap gate are all
 * the engine's — and adds only the step-scoped input view that only the host
 * can have.
 */
export class TeamPressurePolicy {
  private readonly host: TeamPressurePolicyHost
  private readonly policy: ContextPressurePolicy<SessionId>

  constructor(options: TeamPressurePolicyOptions) {
    this.host = new TeamPressurePolicyHost(options)
    this.policy = new ContextPressurePolicy(this.host, TEAM_PRESSURE_TEXT, options.gate)
  }

  /** The pre-step decision for one live Session, with the input that step claims. */
  async onPreStep(sessionId: SessionId, messages: readonly UserMessage[], signal: AbortSignal): Promise<PressureStepDecision> {
    this.host.beginStep(sessionId, messages)
    try {
      return await this.policy.onPreStep(sessionId, signal)
    } finally {
      this.host.endStep(sessionId)
    }
  }

  onRequestError(sessionId: SessionId, failure: { readonly code?: string | undefined }, signal: AbortSignal): Promise<boolean> {
    return this.policy.onRequestError(sessionId, failure, signal)
  }

  onAssistantMessage(sessionId: SessionId): void {
    this.policy.onAssistantMessage(sessionId)
  }

  dispose(): void {
    this.policy.dispose()
  }
}

/** The text a step is admitting that came from outside Team, in arrival order. */
function externalInputText(messages: readonly UserMessage[]): string {
  return messages.flatMap(message => isAgentTeamSource(message.source) ? [] : [messageText(message)]).join('\n')
}

/** One message's visible text, blocks in order. */
function messageText(message: Message): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
