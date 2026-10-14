import type { CSSProperties, ReactNode } from 'react'
import { memberHue } from './team-formatters.ts'
import { useAvatarImage } from './avatar-image.ts'
import css from './member-avatar-seat.module.css'

/**
 * One Member's face, in the three places the Team draws it.
 *
 * The seat is shared rather than repeated because D1 asks the same Member to
 * come out the same colour in all three, and the colour is derived from the
 * Member identity alone — so a seat that computed its own hue would be a second
 * rule waiting to disagree with the first.
 *
 * Two states, one geometry. Without bytes the seat draws the handle's initial
 * on the Member's full-hue fill (`hsl(hue 42% 46%)`, the rule the roster, the
 * sidebar and the mention chip already followed). With bytes it draws them.
 * A payload the browser cannot decode comes back as no bytes at all —
 * `useAvatarImage` remembers the URL that failed — so a phone photo in HEIC
 * lands on the initial instead of a blank circle, which is the fallback D4
 * asks for and one the seat cannot get wrong by trusting the ref.
 */
export function MemberAvatarSeat({ memberId, handle, avatarUrl, size, label, className, badge, style }: {
  /** Identity the hue derives from; the same Member must read the same everywhere. */
  readonly memberId: string
  /** Name the initial falls back to, with or without its leading `@`. */
  readonly handle: string
  /** Uploaded avatar URL, or `undefined` for a Member that has never had one. */
  readonly avatarUrl: string | undefined
  /** Rendered diameter in pixels: 24 for the roster and a bubble, 18 for a mention chip. */
  readonly size: 18 | 24
  /** Accessible name; omitted when the seat sits beside text that already names the Member. */
  readonly label?: string | undefined
  /** Seat-specific layout hooks, so each caller keeps owning its placement. */
  readonly className?: string | undefined
  /** Presence dot, drawn over the bottom-right edge by the caller. */
  readonly badge?: ReactNode
  /** Hue carried in from a caller that already has one, for CSS-only callers. */
  readonly style?: CSSProperties | undefined
}) {
  const image = useAvatarImage(avatarUrl)
  const seatStyle = { '--team-avatar-hue': memberHue(memberId), ...style } as CSSProperties
  return (
    <span
      className={className === undefined ? css.seat : `${css.seat} ${className}`}
      style={seatStyle}
      data-avatar={image.src === undefined ? 'initial' : 'image'}
      data-avatar-size={size}
      {...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      {image.src === undefined
        ? initialOf(handle)
        : <img className={css.image} src={image.src} alt="" aria-hidden="true" onError={image.failed} />}
      {badge}
    </span>
  )
}

/** The handle's first letter, upper-cased: the fallback every Member seat already drew. */
function initialOf(handle: string): string {
  return handle.replace('@', '').slice(0, 1).toUpperCase()
}
