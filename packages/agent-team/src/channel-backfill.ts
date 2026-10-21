import type { AgentTeamChannelRef, AgentTeamHumanActor, AgentTeamMemberId, AgentTeamRequestId } from './types.ts'
import type { AgentTeamChannelParticipation, AgentTeamLedger } from './ledger.ts'

/** One (Member, Channel) pair a backfill would enrol, and the request that does it. */
export interface AgentTeamBackfillEntry {
  readonly channelRef: AgentTeamChannelRef
  readonly channelName: string
  readonly memberId: AgentTeamMemberId
  readonly requestId: AgentTeamRequestId
}

/** What a backfill found, and what running it then did. */
export interface AgentTeamBackfillReport {
  /** The enrolments the derivation reports but no membership carries. */
  readonly planned: readonly AgentTeamBackfillEntry[]
  /** How many of `planned` this run actually wrote; a re-run writes zero. */
  readonly written: number
}

/** Only these Channels are in scope; an absent list means every Channel. */
export interface AgentTeamBackfillOptions {
  readonly channelRefs?: readonly AgentTeamChannelRef[]
}

/**
 * Enrol every Member a Channel's Thread participation exposes, before the rule
 * that derives that participation is removed.
 *
 * Replaying a Ledger can only re-derive a membership from a Thread the Member
 * took part in, so removing the derivation without this would drop those
 * Members out of Channels they were already being shown. The repair writes the
 * ordinary membership record a Human's own addition would have written; it
 * invents no source, because there is no inviter to name — the Member took part
 * in a discussion rather than being named in one.
 *
 * The request id is derived from the pair so a re-run is a retry of the same
 * request rather than a second enrolment, and its prefix marks the record as a
 * repair for anyone reading the log later.
 */
export async function backfillDerivedChannelMemberships(
  ledger: AgentTeamLedger,
  actor: AgentTeamHumanActor,
  options: AgentTeamBackfillOptions = {},
): Promise<AgentTeamBackfillReport> {
  const scope = options.channelRefs === undefined ? undefined : new Set(options.channelRefs)
  const planned = ledger.channelParticipations()
    .filter(entry => !entry.explicit && (scope === undefined || scope.has(entry.channelRef)))
    .map(entry => toEntry(ledger, entry))
  let written = 0
  for (const entry of planned) {
    const workspaceId = ledger.workspaceOfChannel(entry.channelRef)
    if (workspaceId === undefined) continue
    const result = await ledger.joinChannel({
      requestId: entry.requestId,
      workspaceId,
      channelRef: entry.channelRef,
      memberId: entry.memberId,
      actor,
    })
    // A retried request resolves to the record an earlier run wrote; counting it
    // as written would misreport a second run as having repaired anything.
    if (result.committed) written += 1
  }
  return Object.freeze({ planned: Object.freeze(planned), written })
}

function toEntry(ledger: AgentTeamLedger, participation: AgentTeamChannelParticipation): AgentTeamBackfillEntry {
  return Object.freeze({
    channelRef: participation.channelRef,
    channelName: participation.channelName,
    memberId: participation.memberId,
    requestId: `agent-team:backfill-channel-member:${participation.channelRef}:${participation.memberId}` as AgentTeamRequestId,
  })
}
