// One-shot repair for Channel membership, run deliberately and never at startup.
//
// A Member who took part in a Channel's Threads is treated as a member of that
// Channel even without a membership record. That derivation is temporary: it is
// being removed, and removing it would drop those Members out of Channels they
// are already shown. This script writes the membership record a Human's own
// addition writes, for the Members the derivation is still carrying.
//
// The scope is fixed in this file. A command-line override would mean one
// forgotten argument enrols people into every Channel in the Ledger, so the only
// way to change what this touches is to edit the constant and have it reviewed.
//
//   node --import tsx scripts/backfill-channel-members.ts           # rehearsal
//   node --import tsx scripts/backfill-channel-members.ts --write   # repair
//
// A rehearsal opens the same storage read path and writes nothing: it reports
// what --write would enrol. Every failure (lock held, schema mismatch) prints
// its reason and exits non-zero. Nothing is retried — a half-applied repair is
// worse than a stopped one, and a re-run is safe because every request id is
// derived from the pair it enrols.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { AgentTeamLedger, agentTeamHumanActor } from '../packages/agent-team/src/ledger.ts'
import { agentTeamDomainSpec } from '../packages/agent-team/src/spec.ts'
import { backfillDerivedChannelMemberships } from '../packages/agent-team/src/channel-backfill.ts'
import type { AgentTeamChannelRef, AgentTeamOperation, AgentTeamOperationId } from '../packages/agent-team/src/types.ts'

/** The one Channel this repair covers. Editing this is how the scope changes. */
const CHANNEL = 'channel:875683df-3ab4-485b-95ec-25b324aae79c' as AgentTeamChannelRef

const write = process.argv.includes('--write')
const databasePath = join(homedir(), '.dsh', 'storages', 'agent_team.sqlite')

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  // `journalMode` is required: the backend reads it when configuring the
  // database and fails on `undefined` before any record is touched.
  ctx.storage.backend.register('sqlite', new SqliteStorageBackend({ path: databasePath, journalMode: 'wal' }))
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  try {
    const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
    const ledger = new AgentTeamLedger(domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
    await ledger.initialize()

    report(ledger, 'before')
    if (!write) {
      // A rehearsal must not reach the writer at all: it lists the enrolments the
      // repair would make, and opening the storage is the only thing it shares
      // with `--write`.
      const planned = ledger.channelParticipations().filter(entry => entry.channelRef === CHANNEL && !entry.explicit)
      for (const entry of planned) console.log(`${entry.channelName} | ${entry.memberId}`)
      console.log(`\n${planned.length} enrolment(s) would be written. Re-run with --write.`)
      return
    }
    const result = await backfillDerivedChannelMemberships(ledger, agentTeamHumanActor(), { channelRefs: [CHANNEL] })
    console.log(`\nwritten: ${result.written}`)
    report(ledger, 'after')
    const replay = await backfillDerivedChannelMemberships(ledger, agentTeamHumanActor(), { channelRefs: [CHANNEL] })
    console.log(`re-run: planned ${replay.planned.length}, written ${replay.written}`)
  } finally {
    await facility.closeAll()
  }
}

function report(ledger: AgentTeamLedger, when: 'before' | 'after'): void {
  const rows = ledger.channelParticipations()
  const target = rows.filter(row => row.channelRef === CHANNEL)
  const explicit = target.filter(row => row.explicit).length
  const elsewhere = rows.filter(row => row.channelRef !== CHANNEL && !row.explicit).length
  console.log(`[${when}] participations ${rows.length} | ${CHANNEL} ${target.length} rows (explicit ${explicit}, derived ${target.length - explicit}) | other Channels derived ${elsewhere}`)
}

await main().catch(error => {
  console.error(`backfill failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
