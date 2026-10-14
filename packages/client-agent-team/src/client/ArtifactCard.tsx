/**
 * One Message's artifacts, drawn as cards inside its bubble.
 *
 * The card is a pointer, not a copy: it names the file and hands it to the
 * shipped right rail, which is where the file is actually shown. What it does
 * own is the truth about its own state — reading, openable, or unreadable with
 * a reason and a way out — because a card that silently does nothing when its
 * file is gone is worse than one that says so.
 */
import { memo, useCallback, useId, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { AgentTeamMessageArtifact } from '@contexera/dsh-agent-team/types'
import type { UseResource } from '@deepseek-ai/dsh-client-resources/client'
// Brings the `file` protocol member into `ResourceProtocolMap` for the hook call below.
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { artifactAddress, artifactFailureOf, artifactFailureWording, artifactFileName, artifactKindMark, artifactKey, type ArtifactFailure } from './artifact-card.ts'
import type { TeamArtifactSeat } from './artifact-seat.ts'
import type { TeamKey } from './locales.ts'
import type { TeamConversationProps } from './slots.ts'
import css from './artifact-card.module.css'

export interface TeamArtifactCardsProps {
  /** The artifacts this Message's author declared; empty draws nothing at all. */
  readonly artifacts: readonly AgentTeamMessageArtifact[]
  /** Stable row keys when the same path can appear in multiple Messages. */
  readonly rowKeys?: readonly string[] | undefined
  /** Optional list styling for the dedicated Thread artifacts view. */
  readonly listClassName?: string | undefined
  /** The shell seat that places a file in the right rail. */
  readonly seat: TeamArtifactSeat
  /** The shipped `file` provider's live state, as every slot component receives it. */
  readonly useResource: UseResource
  readonly t?: TeamConversationProps['t'] | undefined
}

/**
 * Draw one Message's artifact cards.
 *
 * An empty list draws nothing: the artifact entry is a fact a Message either
 * carries or does not, and an empty card would claim a file that was never
 * declared.
 * @param props - the Message's artifacts, the rail seat, and the resource hook.
 * @returns the card list, or `undefined` when the Message carries no artifact.
 */
export function TeamArtifactCards({ artifacts, rowKeys, listClassName, seat, useResource, t }: TeamArtifactCardsProps): ReactElement | undefined {
  if (artifacts.length === 0) return undefined
  return <div className={`${css.artifactList}${listClassName === undefined ? '' : ` ${listClassName}`}`} data-artifacts={artifacts.length}>
    {artifacts.map((artifact, index) => <ArtifactCard
      key={rowKeys?.[index] ?? artifactKey(artifact)}
      artifact={artifact}
      seat={seat}
      useResource={useResource}
      {...(t === undefined ? {} : { t })}
    />)}
  </div>
}

interface ArtifactCardProps {
  readonly artifact: AgentTeamMessageArtifact
  readonly seat: TeamArtifactSeat
  readonly useResource: UseResource
  readonly t?: TeamConversationProps['t'] | undefined
}

const ArtifactCard = memo(function ArtifactCard({ artifact, seat, useResource, t }: ArtifactCardProps): ReactElement {
  const address = artifactAddress(artifact)
  // Read through the shipped `file` provider: the same state the panel's own
  // tab reads, so the card and the panel cannot disagree about the file.
  const state = useResource<'file'>(address)
  const subscribeCurrent = useCallback((listener: () => void): (() => void) => seat.subscribeCurrent(listener), [seat])
  const readCurrent = useCallback((): boolean => seat.isCurrent(address), [seat, address])
  const current = useSyncExternalStore(subscribeCurrent, readCurrent, readCurrent)
  // A refusal from the rail itself (nothing on screen, or an address no type
  // will open) outranks the file's own state: it is what just happened.
  const [refusal, setRefusal] = useState<ArtifactFailure | undefined>()
  const [copied, setCopied] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const warnId = useId()
  const failure = refusal ?? (state.status === 'none' ? 'unreadable' : state.status === 'failed' ? artifactFailureOf(state.failure?.code) : undefined)
  // `none` means no provider currently owns this address, not a read in progress.
  // It may recover when a provider registers, but until then show the same explicit
  // unavailable state and copy-path exit as other unreadable addresses.
  const loading = failure === undefined && state.status === 'loading'
  const name = artifactFileName(artifact.path)
  const wording = failure === undefined ? undefined : artifactFailureWording[failure]
  const open = (): void => { setRefusal(seat.open(artifact, buttonRef.current ?? undefined)) }
  const copyPath = (): void => {
    void writeClipboard(artifact.path).then(accepted => { setCopied(accepted) })
  }
  const label = (key: TeamKey, params?: Record<string, unknown>): string => t === undefined ? String(params?.['name'] ?? key) : t(key, params)
  return <div className={css.artifactItem} data-artifact-state={failure === undefined ? (loading ? 'loading' : 'ready') : 'failed'}>
    <button
      ref={buttonRef}
      type="button"
      className={css.artifactCard}
      data-artifact-address={address}
      {...(current ? { 'aria-current': 'true' as const } : {})}
      {...(loading ? { disabled: true, 'aria-busy': 'true' as const } : {})}
      {...(wording === undefined ? { 'aria-label': label('artifactOpenOne', { title: name }) } : { 'aria-describedby': warnId })}
      onClick={open}
    >
      <span className={css.aIcon} {...(failure === undefined ? {} : { 'data-tone': 'warn' })} aria-hidden="true">{failure === undefined ? artifactKindMark(artifact.path) : '!'}</span>
      <span className={css.aTitle}>{loading ? label('artifactLoading') : wording === undefined ? name : label(wording.title, { name })}</span>
      <span className={css.aMeta} title={artifact.path}>{artifact.path}</span>
      <span className={css.aOpen} aria-hidden="true">{loading ? '' : failure === undefined ? '›' : '↻'}</span>
    </button>
    {wording !== undefined && <div className={css.artifactWarn} id={warnId}>
      <b>{label(wording.headline)}</b>
      <span>{label(wording.detail)}</span>
      <button type="button" className={css.artifactCopy} onClick={copyPath}>
        {copied ? label('artifactPathCopied') : label('artifactCopyPath')}
      </button>
    </div>}
  </div>
})
