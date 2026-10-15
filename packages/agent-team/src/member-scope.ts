import type {
  AgentTeamMemberScopeKey,
  AgentTeamMemberScopeKind,
  AgentTeamMemberScopeSession,
  AgentTeamThreadRef,
  AgentTeamWorkingDirectorySet,
} from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * The one work domain every fact with no work domain of its own belongs to:
 * Member lifecycle and recovery facts, and the single Session a ledger recorded
 * before buckets existed. Replaying such a ledger yields exactly this binding,
 * which is what keeps the change inert until a second domain appears.
 */
export const DEFAULT_MEMBER_SCOPE_KEY = 'default' as AgentTeamMemberScopeKey

/** Separator between a scope key's namespace and its ref; refs never contain it. */
const SCOPE_KEY_SEPARATOR = ':'

/**
 * The bucket of one discussion. A taskless discussion and the same discussion
 * after `promoteThread` share this key: the Task is the domain's mutable
 * overlay, never its identity.
 */
export function threadMemberScopeKey(threadRef: AgentTeamThreadRef): AgentTeamMemberScopeKey {
  return scopeKey('thread', threadRef)
}

function scopeKey(kind: AgentTeamMemberScopeKind, ref: string): AgentTeamMemberScopeKey {
  return `${kind}${SCOPE_KEY_SEPARATOR}${ref}` as AgentTeamMemberScopeKey
}

/**
 * The namespace and ref a key encodes. Keys are written by this module alone,
 * so an unreadable key is a corrupt or hand-edited ledger: it is rejected
 * rather than silently defaulted into the `default` domain, which would mix an
 * unknown domain's facts into the Member's legacy Session.
 *
 * `thread` is the only isolation this bundle grants today, because a discussion
 * is the only kind of fact a Member's unread work is carried by. A Channel or
 * DM namespace would be a second key shape with no producer and no consumer.
 */
export function parseMemberScopeKey(scopeKey: string): { readonly scopeKind: AgentTeamMemberScopeKind; readonly scopeRef?: string | undefined } {
  if (scopeKey === DEFAULT_MEMBER_SCOPE_KEY) return { scopeKind: 'default' }
  const separator = scopeKey.indexOf(SCOPE_KEY_SEPARATOR)
  if (separator < 1) throw new Error(`Member scope key '${scopeKey}' carries no namespace`)
  const namespace = scopeKey.slice(0, separator)
  const scopeRef = scopeKey.slice(separator + 1)
  if (scopeRef === '') throw new Error(`Member scope key '${scopeKey}' carries no ref`)
  if (namespace !== 'thread') {
    throw new Error(`Member scope key '${scopeKey}' names unknown scope kind '${namespace}'`)
  }
  return { scopeKind: namespace, scopeRef }
}

/**
 * One durable binding, with its namespace fields derived from the key so a
 * caller cannot state a kind the key disagrees with. This is the only way a
 * binding is built, on the write path and in replay validation alike.
 */
export function memberScopeSession(
  scopeKey: AgentTeamMemberScopeKey,
  sessionId: SessionId,
  workingDirectories?: AgentTeamWorkingDirectorySet,
): AgentTeamMemberScopeSession {
  const { scopeKind, scopeRef } = parseMemberScopeKey(scopeKey)
  return Object.freeze({
    scopeKey, scopeKind, ...(scopeRef === undefined ? {} : { scopeRef }), sessionId,
    ...(workingDirectories === undefined ? {} : { workingDirectories: Object.freeze([...workingDirectories]) }),
  })
}
