/**
 * One Message artifact's file, as this Client can name and read it.
 *
 * A Message carries artifacts as facts — the author Session and a path — and
 * never as bytes. Everything here follows from that: the address is built from
 * the author Session (the working copy the file was written in), the card reads
 * the state through the shipped `file` provider, and the panel is opened
 * through the shipped right rail. Nothing in this file reads a file or draws a
 * panel of its own.
 */
import type { AgentTeamMessageArtifact } from '@contexera/dsh-agent-team/types'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { TeamKey } from './locales.ts'

/** How an artifact's file reads right now, keyed by what the reader must do. */
export type ArtifactFailure =
  /** The file the entry names is not there any more. */
  | 'missing'
  /** The path is outside the producing Session's workspace, so it is not readable here. */
  | 'outside-workspace'
  /** The Session that produced the artifact is gone, so nobody can read that copy. */
  | 'session-gone'
  /** No registered type will open this address, or the open call refused it. */
  | 'unreadable'
  /** Nothing is on screen to open into: the right rail has no Session to place a tab in. */
  | 'no-session'

/**
 * The `file` address an artifact is read at.
 *
 * The address names the artifact's own Session, never the reader's: a Member's
 * artifact is a file in that Member's working copy, and the Host authorizes the
 * read against that Session. No `cwd` travels with the artifact, so the path
 * stands as the absolute path it was recorded as — the Host resolves it against
 * the Session's root and reports `outside-workspace` when it falls outside.
 * @param artifact - the artifact fact from the Message.
 * @returns a `dsh-resource://file/session/<sessionId>/<path>` address.
 */
export function artifactAddress(artifact: AgentTeamMessageArtifact): string {
  return fileAddressFor(artifact.sessionId, undefined, artifact.path)
}

/** Stable key for one artifact row: the Session and path that identify the file. */
export function artifactKey(artifact: AgentTeamMessageArtifact): string {
  return `${artifact.sessionId}\u0000${artifact.path}`
}

/**
 * The artifact's file name, which is what a card leads with.
 * @param path - the recorded path, absolute or relative.
 * @returns the last path segment, or the path itself when it names a root.
 */
export function artifactFileName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/u, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * The short type mark a card shows in place of an icon: the file's extension,
 * uppercased and capped so one label never widens the card.
 * @param path - the recorded path.
 * @returns up to four characters; `FILE` when the name carries no extension.
 */
export function artifactKindMark(path: string): string {
  const name = artifactFileName(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return 'FILE'
  return name.slice(dot + 1).toUpperCase().slice(0, 4)
}

/**
 * What a provider's failure code means to a reader.
 *
 * The `file` protocol distinguishes a file that is gone from a path outside the
 * workspace, and the two need different words and different ways out, so they
 * are never folded together. Anything else stays a plain "cannot read".
 * @param code - `RemoteFailure.code` from the resource snapshot, when there is one.
 * @returns the failure a card renders.
 */
export function artifactFailureOf(code: string | undefined): ArtifactFailure {
  if (code === undefined) return 'unreadable'
  if (code === 'workspace-file/not-found') return 'missing'
  if (code === 'workspace-file/outside-workspace') return 'outside-workspace'
  if (code === 'workspace-file/unknown-workspace') return 'session-gone'
  return 'unreadable'
}

/**
 * The locale keys one failure renders: the mark on the card's title, the
 * sentence naming the reason, and the paragraph that offers the way out.
 */
export interface ArtifactFailureWording {
  /** Title suffix, e.g. `{name}（已删除）`. */
  readonly title: TeamKey
  /** The reason, in one sentence, shown under the card. */
  readonly headline: TeamKey
  /** What the reader can do about it. */
  readonly detail: TeamKey
}

/**
 * The wording one failure renders. Kept beside the vocabulary so a new reason
 * cannot be added without words to show for it.
 */
export const artifactFailureWording: Readonly<Record<ArtifactFailure, ArtifactFailureWording>> = {
  missing: { title: 'artifactMissingTitle', headline: 'artifactMissingHeadline', detail: 'artifactMissingDetail' },
  'outside-workspace': { title: 'artifactOutsideTitle', headline: 'artifactOutsideHeadline', detail: 'artifactOutsideDetail' },
  'session-gone': { title: 'artifactSessionGoneTitle', headline: 'artifactSessionGoneHeadline', detail: 'artifactSessionGoneDetail' },
  unreadable: { title: 'artifactUnreadableTitle', headline: 'artifactUnreadableHeadline', detail: 'artifactUnreadableDetail' },
  'no-session': { title: 'artifactNoSessionTitle', headline: 'artifactNoSessionHeadline', detail: 'artifactNoSessionDetail' },
}
