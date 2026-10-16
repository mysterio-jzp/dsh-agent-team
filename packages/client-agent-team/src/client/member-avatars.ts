import { useSyncExternalStore } from 'react'

/**
 * The Client's one map from a Member avatar reference to a drawable URL.
 *
 * A Member's picture is stored by reference and the Member record says which
 * reference it wears, so the map is keyed by reference and shared by every seat
 * that draws that Member — timeline rows, roster lines, mention chips — which
 * is what keeps one face identical everywhere it appears.
 *
 * It is deliberately not the Human's identity store. The Human's bytes and a
 * Member's bytes belong to different people, and the one failure this pairing
 * exists to prevent is a seat drawing one person's picture under another's
 * name. Keeping the two stores apart means a seat cannot reach the wrong bytes
 * by accident.
 *
 * Bytes are immutable per reference, so a resolved URL is cached and never
 * re-fetched; a reference that resolves to nothing is remembered as a failure
 * so a broken Member does not re-request on every render.
 */

/** Host calls this map reads through; one loader per Client context. */
export interface TeamMemberAvatarsLoader {
  /** Resolve one Member avatar reference to a displayable URL; null draws the initial. */
  loadAvatarUrl: (avatarRef: string) => Promise<string | null>
}

/** One member's resolved face, as every seat sees it. */
export type TeamMemberAvatarState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'unavailable' }

const LOADING: TeamMemberAvatarState = { status: 'loading' }
const UNAVAILABLE: TeamMemberAvatarState = { status: 'unavailable' }

export class TeamMemberAvatars {
  private readonly states = new Map<string, TeamMemberAvatarState>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly listeners = new Set<() => void>()
  private readonly loader: TeamMemberAvatarsLoader

  constructor(loader: TeamMemberAvatarsLoader) {
    this.loader = loader
  }

  /**
   * The face for one reference, starting its read on first ask.
   * @param avatarRef - the reference stored on the Member record.
   * @returns the resolved state, `loading` until the read settles.
   */
  readonly getSnapshot = (avatarRef: string): TeamMemberAvatarState => {
    const held = this.states.get(avatarRef)
    if (held === undefined) {
      void this.load(avatarRef)
      return LOADING
    }
    return held
  }

  /**
   * Observe the whole map; every seat re-reads after any reference settles.
   * @param listener - invoked after any reference changes state.
   * @returns the disposer removing this listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.listeners.clear()
  }

  /**
   * Seed a reference that the caller already resolved, so a seat that uploaded
   * or read bytes elsewhere draws them without a second round trip.
   * @param avatarRef - the reference the bytes belong to.
   * @param url - displayable URL, or null when the bytes do not decode.
   */
  seed(avatarRef: string, url: string | null): void {
    // Uploaded bytes supersede any Host read that is still in flight.
    this.pending.delete(avatarRef)
    this.commit(avatarRef, url === null ? UNAVAILABLE : { status: 'ready', url })
  }

  private load(avatarRef: string): Promise<void> {
    const running = this.pending.get(avatarRef)
    if (running !== undefined) return running
    const loading = this.read(avatarRef).then(url => {
      if (this.pending.get(avatarRef) !== loading) return
      this.commit(avatarRef, url === null ? UNAVAILABLE : { status: 'ready', url })
    }).finally(() => {
      if (this.pending.get(avatarRef) === loading) this.pending.delete(avatarRef)
    })
    this.pending.set(avatarRef, loading)
    return loading
  }

  private async read(avatarRef: string): Promise<string | null> {
    try {
      return await this.loader.loadAvatarUrl(avatarRef)
    } catch {
      // A dropped carrier and a refused read both leave the seat without bytes,
      // and the initial is what it owes the reader either way.
      return null
    }
  }

  private commit(avatarRef: string, state: TeamMemberAvatarState): void {
    this.states.set(avatarRef, state)
    for (const listener of this.listeners) listener()
  }
}

/**
 * Subscribe one seat to one Member's face.
 * @param avatars - the shared map, or undefined on a surface without the Remote.
 * @param avatarRef - the reference this Member wears, if any.
 * @returns the resolved URL, or undefined while it loads or cannot be drawn.
 */
export function useMemberAvatarUrl(avatars: TeamMemberAvatars | undefined, avatarRef: string | undefined): string | undefined {
  if (avatars === undefined) return undefined
  const state = useSyncExternalStore(
    avatars.subscribe,
    () => (avatarRef === undefined ? UNAVAILABLE : avatars.getSnapshot(avatarRef)),
    () => (avatarRef === undefined ? UNAVAILABLE : avatars.getSnapshot(avatarRef)),
  )
  return state.status === 'ready' ? state.url : undefined
}
