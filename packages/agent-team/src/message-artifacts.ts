/**
 * Message artifacts: the files a Member Session declared for delivery through
 * the Harness `present` tool while it was writing a Message.
 *
 * Team forwards the Harness delivery surface instead of inventing one. A
 * successful `present` appends `deliverables/presented` to the declaring
 * Session — paths and their descriptions, never contents — and this unit folds
 * those declarations per turn, so a Message can carry the coordinates of what
 * its author was handing over at that moment. Nothing here reads a file: the
 * preview resolves each stored path inside the Session that produced it.
 *
 * The fold resets on `turn/start`: a declaration belongs to the turn that made
 * it, and a Message committed in a later turn must not inherit it.
 */
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
// The producer keeps `PresentedFile` off its main entry, so the declaring type
// is imported where it lives: the same type the `deliverables/presented`
// augmentation types its `files` with, which is what keeps this fold honest
// about the shape it folds.
import type { PresentedFile } from '@deepseek-ai/dsh-tool-present/types'
import type { AgentTeamMessageArtifact } from './types.ts'

/** The projection key Team owns over the Harness delivery surface. */
export const MESSAGE_ARTIFACTS_PROJECTION_KEY = 'agentTeamPresentedFiles' as const

/** One successful `present` call: the files it declared, in call order. */
export interface PresentedDelivery {
  /** The declaring `present` call; a Message claims a call at most once. */
  readonly callId: string
  readonly files: readonly PresentedDeliveryFile[]
}

/**
 * One declared file inside the folded state. The declaration itself
 * ({@link PresentedFile}) types `description` as an optional string; the folded
 * state admits an explicit `undefined` because `exactOptionalPropertyTypes`
 * keeps a parsed record's own shape exact.
 */
export interface PresentedDeliveryFile {
  readonly path: string
  readonly description?: string | undefined
}

/** One Session's declarations in the turn that holds them. */
export interface PresentedTurnDeliveries {
  /** The turn the declarations belong to; -1 before the Session declared anything. */
  readonly turn: number
  /** Successful declarations of that turn, in append order. */
  readonly deliveries: readonly PresentedDelivery[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Declarations one Session's `present` calls made during its current turn. */
    agentTeamPresentedFiles: PresentedTurnDeliveries
  }
}

const deliveredFileSchema: z.ZodType<PresentedDeliveryFile> = z.object({
  path: z.string().min(1),
  description: z.string().optional(),
}).strict()

const stateSchema: z.ZodType<PresentedTurnDeliveries> = z.object({
  turn: z.number().int(),
  deliveries: z.array(z.object({
    callId: z.string().min(1),
    files: z.array(deliveredFileSchema),
  }).strict()),
}).strict()

/** No declarations yet: the state of a Session that never called `present`. */
const NO_DELIVERIES: PresentedTurnDeliveries = Object.freeze({ turn: -1, deliveries: [] })

/**
 * The unit registered once per Host, like Team's continuity projection: the
 * framework keeps one unit per projection key and drives it for every Session,
 * so the definition closes over no Session identity. A Session that declared
 * nothing, and one whose declarations a later turn reset, are the same empty
 * state.
 */
export const presentedDeliveriesProjection = {
  key: MESSAGE_ARTIFACTS_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema,
  init: (): PresentedTurnDeliveries => NO_DELIVERIES,
  apply(state: PresentedTurnDeliveries, event: SessionEvent): PresentedTurnDeliveries {
    if (event.type === 'turn/start') {
      return event.data.turn === state.turn ? state : { turn: event.data.turn, deliveries: [] }
    }
    if (event.type !== 'deliverables/presented') return state
    const { turn, callId, files } = event.data
    // A declaration for a turn the fold has left behind (a slow nested result
    // landing after the turn ended) can no longer belong to any Message.
    if (turn !== state.turn) return state
    if (state.deliveries.some(delivery => delivery.callId === callId)) return state
    return {
      turn,
      deliveries: [...state.deliveries, { callId, files: files.map(file => ({ ...file })) }],
    }
  },
}

/** One Message's claim on its Session's declarations. */
export interface ClaimedArtifacts {
  /** The artifacts the Message stores; empty when it delivers nothing. */
  readonly artifacts: readonly AgentTeamMessageArtifact[]
  /** The declaring calls the Message consumes. */
  readonly callIds: readonly string[]
}

/** Nothing claimed: a Human Message, a Session that declared nothing, or a second Message of one turn. */
export const NOTHING_CLAIMED: ClaimedArtifacts = Object.freeze({ artifacts: [], callIds: [] })

/**
 * One declared file as the absolute path a preview opens: a relative
 * declaration resolves against the declaring Session's working directory.
 * @param cwd - that Session's working directory, absent outside a workspace.
 * @param path - the declared path, absolute or relative to `cwd`.
 * @returns the absolute path, or undefined when neither form is available.
 */
function absoluteArtifactPath(cwd: string | undefined, path: string): string | undefined {
  if (isAbsolute(path)) return path
  return cwd === undefined || cwd.length === 0 ? undefined : resolve(cwd, path)
}

/**
 * Claim the declarations of the current turn that no earlier Message carries.
 *
 * Declaration order is Message order within one turn: the first Message takes
 * everything declared before it and the next one takes what came after, so one
 * file never appears on two Messages of the same turn.
 * @param sessionId - the declaring Session, stored on every artifact.
 * @param cwd - that Session's working directory for relative declarations.
 * @param deliveries - the folded declarations, or undefined when the unit is unregistered.
 * @param carried - calls an earlier Message of the same turn already consumed.
 * @returns the artifacts to store and the calls they consume.
 */
export function claimMessageArtifacts(
  sessionId: SessionId,
  cwd: string | undefined,
  deliveries: PresentedTurnDeliveries | undefined,
  carried: ReadonlySet<string>,
): ClaimedArtifacts {
  const fresh = deliveries?.deliveries.filter(delivery => !carried.has(delivery.callId)) ?? []
  if (fresh.length === 0) return NOTHING_CLAIMED
  const artifacts: AgentTeamMessageArtifact[] = []
  const callIds: string[] = []
  const claimed = new Set<string>()
  for (const delivery of fresh) {
    callIds.push(delivery.callId)
    for (const file of delivery.files) {
      const path = absoluteArtifactPath(cwd, file.path)
      if (path === undefined || claimed.has(path)) continue
      claimed.add(path)
      artifacts.push(Object.freeze({
        sessionId,
        path,
        ...(file.description === undefined ? {} : { description: file.description }),
      }))
    }
  }
  return { artifacts: Object.freeze(artifacts), callIds: Object.freeze(callIds) }
}
