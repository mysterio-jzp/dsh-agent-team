import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { AgentTeamAttachmentId, AgentTeamGetAttachmentRequest, AgentTeamGetAttachmentResult, AgentTeamMessageAttachment } from '@contexera/dsh-agent-team/types'

/**
 * Opening a cached attachment in the right Sidebar.
 *
 * Two facts shape this module:
 *
 * 1. The Sidebar only claims `dsh-resource://file/session/<sessionId>/<path>`
 *    addresses, and an address no type claims is a wiring mistake there, not a
 *    user error: `openResource` throws. So every address built here has to be
 *    session-scoped, which is also why opening needs a Session on screen.
 * 2. The path is never invented on this side. The Host resolves it from the
 *    `attachmentId` alone, so what this module can ask to open is exactly the
 *    set of attachments the caller can name — not any path on the machine.
 *
 * The bytes come from the attachment cache, which is a snapshot taken when the
 * file was sent. What the reader sees is that copy, never the original as it
 * stands now; the surface that calls this says so next to the attachment.
 */

/** Why an attachment could not be opened. Each has a different next step for the reader. */
export type AttachmentOpenFailure =
  /** The cache entry is gone: the copy expired, and only the sender can re-send it. */
  | 'expired'
  /** The Host refused the read for a reason other than the entry being gone. */
  | 'refused'
  /** No Sidebar type would open the address — the Host has no viewer for it. */
  | 'unsupported'
  /** Nothing is on screen for the Sidebar to open it in. */
  | 'no-session'
  /** The open reported neither an error nor a recorded tab, so it cannot be confirmed. */
  | 'unknown'

/** Open one cached attachment; `null` once the Sidebar accepted the address. */
export type OpenAttachment = (attachment: AgentTeamMessageAttachment) => Promise<AttachmentOpenFailure | null>

/** The slice of the attachment Remote this gesture calls. */
export interface AttachmentReadRemote {
  getAttachment(request: AgentTeamGetAttachmentRequest, signal?: AbortSignal): Promise<RemoteResult<AgentTeamGetAttachmentResult>>
}

/** The slice of `ctx.sidebarRight` this gesture calls. */
export interface AttachmentSidebar {
  /** The Session on screen, or `undefined` while none is. */
  mounted(): string | undefined
  open(address: string): void
  /**
   * The tabs recorded as open, across saved and adopted Sessions.
   *
   * Read because `open` cannot report failure: it returns `void` and, for a
   * Session whose store was never adopted, records nothing and raises nothing.
   * Without this, "the Sidebar took the address" and "nothing happened" look
   * identical from here — which is exactly the silent nothing the block must
   * never show.
   */
  openTabs(): readonly {
    readonly sessionId?: string
    readonly contentId?: string
  }[]
}

const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/**
 * Component-encode one segment, keeping `:` literal for drive letters.
 * @param segment - one address segment.
 * @returns the encoded segment.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * The Session-scoped address of one absolute path.
 *
 * Mirrors the Host's own builder segment for segment. The path stays absolute
 * because the cache lives outside every workspace, and the Host resolves an
 * absolute path against its own filesystem: a path re-joined or normalized
 * here could stop matching the file the Host just handed over.
 * @param sessionId - the Session whose Host workspace resolves the path.
 * @param path - absolute Host path, exactly as the Remote reported it.
 * @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
 */
export function attachmentFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  const encoded = normalized.split('/').map(encodeSegment).join('/')
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encoded}`
}

/**
 * Open one attachment in the right Sidebar.
 * @param sidebar - the right-Sidebar face.
 * @param remote - the attachment Remote namespace.
 * @param attachment - the attachment to open.
 * @returns `null` once the Sidebar accepted the address, else why not.
 */
export async function openAttachmentInSidebar(
  sidebar: AttachmentSidebar,
  remote: AttachmentReadRemote,
  attachment: { readonly attachmentId: AgentTeamAttachmentId },
): Promise<AttachmentOpenFailure | null> {
  // Checked before the round-trip: with no Session on screen the Sidebar has
  // nothing to place a tab in, and the Host read would be wasted work for a
  // gesture that cannot show anything.
  const sessionId = sidebar.mounted()
  if (sessionId === undefined) return 'no-session'

  let result: RemoteResult<AgentTeamGetAttachmentResult>
  try {
    result = await remote.getAttachment({ attachmentId: attachment.attachmentId })
  } catch {
    // An unreachable Host and a refused read are the same thing to the reader:
    // no file opened. Only the entry being gone has its own answer.
    return 'refused'
  }
  if (!result.ok) return result.error.code === 'team/attachment-not-found' ? 'expired' : 'refused'

  const address = attachmentFileAddress(sessionId, result.value.path)
  try {
    sidebar.open(address)
  } catch {
    // `openResource` throws only when no registered type claims the address,
    // which is the Host having no viewer for this content.
    return 'unsupported'
  }
  // `open` answers nothing, so an address the Sidebar never recorded is
  // indistinguishable from one it opened — unless the record is consulted. A
  // Session that is on screen but was never adopted reaches exactly that
  // state: no throw, no tab, no reason shown. Reporting it as unopened is the
  // difference between a failure the reader can act on and a block that looks
  // like it is still working.
  //
  // The address decides this, not the tab count: opening the same attachment
  // again reuses the tab that is already there, so a count that stays the same
  // is the ordinary second click, not a failure.
  return sidebar.openTabs().some(tab => tab.contentId === address && tab.sessionId === sessionId) ? null : 'unknown'
}
