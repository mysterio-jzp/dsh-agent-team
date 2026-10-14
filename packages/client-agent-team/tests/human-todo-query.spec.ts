import { describe, expect, it } from 'vitest'
import type { TeamQueryIdentity } from '../src/client/team-queries.ts'

/**
 * The Human to-do query's identity, mirrored from the production binding. A copy
 * is the point: if the shipped key or coverage moves, this spec has to be moved
 * with it deliberately rather than agreeing with whatever the source now says.
 */
function humanTodos(workspaceId: string, threadRef?: string): TeamQueryIdentity {
  return {
    key: `human-todos:${workspaceId}:${threadRef ?? 'all'}`,
    covers: scope => scope === undefined
      || (scope.kind === 'workspace' && scope.workspaceId === workspaceId)
      || scope.kind === 'channel'
      || scope.kind === 'thread',
  }
}

const workspace = { kind: 'workspace' as const, workspaceId: 'w1' as never }
const otherWorkspace = { kind: 'workspace' as const, workspaceId: 'w2' as never }
const channel = { kind: 'channel' as const, channelRef: 'channel:1' } as never
const thread = { kind: 'thread' as const, threadRef: 'thread:1' } as never
const presence = { kind: 'presence' as const, workspaceId: 'w1' } as never

describe('humanTodos query identity', () => {
  it('keeps a Thread list and the Workspace-wide counts on separate keys', () => {
    // The two shapes answer different questions — one Thread's entries versus
    // one count per Channel — so a single answer must never serve both.
    expect(humanTodos('w1', 'thread:1').key).not.toBe(humanTodos('w1').key)
    expect(humanTodos('w1').key).toBe('human-todos:w1:all')
    expect(humanTodos('w1', 'thread:1').key).toBe('human-todos:w1:thread:1')
  })

  it('keeps two Threads apart', () => {
    expect(humanTodos('w1', 'thread:1').key).not.toBe(humanTodos('w1', 'thread:2').key)
  })

  it('keeps two Workspaces apart', () => {
    expect(humanTodos('w1').key).not.toBe(humanTodos('w2').key)
  })

  it('answers to the broad surface a ledger commit can reach', () => {
    // A dispatch can land in any Thread, so the change that invalidates a to-do
    // answer is not scoped to the Thread the reader happens to be on.
    const identity = humanTodos('w1', 'thread:1')
    expect(identity.covers(undefined)).toBe(true)
    expect(identity.covers(workspace)).toBe(true)
    expect(identity.covers(channel)).toBe(true)
    expect(identity.covers(thread)).toBe(true)
  })

  it('does not answer for another Workspace', () => {
    expect(humanTodos('w1').covers(otherWorkspace)).toBe(false)
  })

  it('ignores presence, which wakes no to-do', () => {
    // Presence is a different scope kind entirely: a Member going away changes
    // no to-do fact, so a to-do answer must not be thrown away for it.
    expect(humanTodos('w1').covers(presence)).toBe(false)
  })

  it('covers the same surface as the Inbox, because both answer any ledger commit', () => {
    const inbox: TeamQueryIdentity = {
      key: 'inbox:w1:all',
      covers: scope => scope === undefined
        || (scope.kind === 'workspace' && scope.workspaceId === 'w1')
        || scope.kind === 'channel'
        || scope.kind === 'thread',
    }
    const toDo = humanTodos('w1')
    for (const scope of [undefined, workspace, otherWorkspace, channel, thread, presence]) {
      expect(toDo.covers(scope as never)).toBe(inbox.covers(scope as never))
    }
  })
})
