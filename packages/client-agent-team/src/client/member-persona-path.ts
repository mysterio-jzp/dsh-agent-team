import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Opening the Member's `agent.md` in whatever application the Host would use.
 *
 * The path is handed over exactly as the projection reports it: absolute, and
 * not touched. The Host verifies a path by round-tripping it through its own
 * filesystem, which resolves symlinks while the check itself only calls
 * `path.resolve` — so a path this side rewrote, normalized, or re-joined could
 * stop matching and come back as a bad request instead of an opened file.
 *
 * A refusal and an unreachable Host are the same thing to the Human: no file
 * opened. So the carrier's own rejection is swallowed into that one answer
 * rather than thrown past the page, and the caller announces it and offers the
 * path to copy.
 */

/** The slice of the Session Remote the gesture calls. */
export interface MemberPersonaPathRemote {
  readonly session: {
    openWorkspacePath(request: { readonly path: string }, signal?: AbortSignal): Promise<RemoteResult<unknown>>
  }
}

/**
 * Ask the Host to open one absolute path.
 * @param remote - the Session Remote namespace running the gesture.
 * @param path - absolute Host path, exactly as the Client projection reported it.
 * @returns `null` once the Host acknowledged, or a message to announce.
 */
export async function openMemberPersonaPath(remote: MemberPersonaPathRemote, path: string): Promise<string | null> {
  try {
    const result = await remote.session.openWorkspacePath({ path })
    return result.ok ? null : result.error.message
  } catch (error) {
    // A Host that could not be reached failed the gesture exactly like one that
    // refused it; both leave the Human without a window, and the page says so.
    return error instanceof Error ? error.message : String(error)
  }
}
