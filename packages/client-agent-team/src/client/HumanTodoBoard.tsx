import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import type { AgentTeamHumanTodo, AgentTeamHumanTodoRef, AgentTeamMemberId, AgentTeamMessageRef } from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import { formatAbsoluteTime, memberHue } from './team-formatters.ts'
import { TeamCountBadge } from './TeamCountBadge.tsx'
import { centerInOwnScroller } from './timeline-scroll.ts'
import css from './human-todos.module.css'

/**
 * The four states the Human reads on a to-do card. `cancelled` is deliberately
 * absent: a withdrawn to-do never reaches this list at all, so a card showing
 * the word would describe something the reader cannot act on.
 */
export type ListedTodoState = 'pending' | 'claimed' | 'answered' | 'closed'

export function listedState(todo: AgentTeamHumanTodo): ListedTodoState {
  return todo.state === 'cancelled' ? 'closed' : todo.state
}

function stateKey(state: ListedTodoState) {
  return state === 'pending' ? 'humanTodoStatePending' as const
    : state === 'claimed' ? 'humanTodoStateClaimed' as const
      : state === 'answered' ? 'humanTodoStateAnswered' as const
        : 'humanTodoStateClosed' as const
}

/**
 * A to-do the Human has not settled yet. The badge on a Channel row counts
 * exactly these; a settled one stays in the list as the record that it was done.
 */
export function isUnsettledTodo(todo: AgentTeamHumanTodo): boolean {
  return todo.state === 'pending' || todo.state === 'claimed' || todo.state === 'answered'
}

/**
 * The instants a to-do card prints. The ledger stores sequences, not clocks, so
 * each one is resolved from the Thread facts the page already holds — a
 * sequence with no matching fact stays absent rather than being invented, and
 * the line then simply omits the instant.
 */
export interface HumanTodoTimes {
  readonly dispatchedAt?: string | undefined
  readonly claimedAt?: string | undefined
}

function instantOf(facts: ReadonlyMap<number, string>, sequence: number | undefined): string | undefined {
  return sequence === undefined ? undefined : facts.get(sequence)
}

/** One Member avatar seat, sized by the surface that draws it. */
function MemberSeat({ memberId, label, size }: { readonly memberId: string; readonly label: string; readonly size: 'list' | 'row' }) {
  return <span
    className={css.seat!}
    data-seat={size}
    style={{ '--team-hue': memberHue(memberId) } as CSSProperties}
    role="img"
    aria-label={label}
    title={label}
  >
    {label.replace(/^@/, '').slice(0, 1).toUpperCase()}
  </span>
}

interface HumanTodoBoardProps {
  readonly workspaceId: WorkspaceId
  readonly humanName: string
  readonly todos: readonly AgentTeamHumanTodo[]
  readonly loading: boolean
  readonly error?: string | undefined
  readonly pending: boolean
  /** Names one Member the way the roster does; an unknown Member falls back to the Host's id. */
  readonly memberName: (memberId: AgentTeamMemberId) => string
  /** Since when each ledger sequence happened, resolved from the Thread facts on screen. */
  readonly times: (todo: AgentTeamHumanTodo) => HumanTodoTimes
  /** The resolved Task number for the origin line, when the Thread carries a Task. */
  readonly taskNumber?: number | undefined
  /** The idle notice a repeat action writes: idempotence has to be visible. */
  readonly notice?: string | undefined
  readonly onClaim: (todo: AgentTeamHumanTodo) => void
  readonly onAnswer: (todo: AgentTeamHumanTodo) => void
  readonly onClose: (todo: AgentTeamHumanTodo) => void
  /** The entry this board was just jumped to from, held for one pulse. */
  readonly flashedTodoRef?: AgentTeamHumanTodoRef | undefined
  readonly t: TeamConversationProps['t']
}

/**
 * The Thread's Human to-dos. Every action here is one the ledger really has for
 * a Human — claiming, answering by replying in the Thread, and closing — and
 * each one names a target state rather than an event, so a repeat writes
 * nothing and says so instead of silently succeeding.
 */
export function HumanTodoBoard({
  humanName, todos, loading, error, pending, memberName, times, taskNumber, notice, onClaim, onAnswer, onClose, flashedTodoRef, t,
}: HumanTodoBoardProps) {
  const flashedRef = useRef<HTMLElement>(null)
  // The jump lands on the entry itself rather than the top of the board.
  // It moves the board's own scroll position, never `scrollIntoView`: the board
  // sits inside the Thread page, and that method walks up the ancestor chain
  // scrolling every scrollable box it meets, so landing on a to-do card would
  // also move the host around it. The entry is not a direct child of the
  // scroller (it sits in `css.todoList` inside `css.board`, the element that
  // carries `overflow-y: auto`), so the container is found by walking up to the
  // nearest scrollable ancestor rather than assuming a fixed depth.
  useEffect(() => {
    const entry = flashedRef.current
    if (flashedTodoRef === undefined || entry === null) return
    centerInOwnScroller(entry)
  }, [flashedTodoRef])

  if (loading && todos.length === 0) return <div className={css.board} data-view-panel="board">
    <p className={css.todoEmpty} aria-busy="true">{t('loadingThread')}</p>
  </div>

  return <div className={css.board} data-view-panel="board" aria-label={t('humanTodoBoardLabel')}>
    {/* What the Channel-row number means, stated where that number's other
        reading is: the badge is every unsettled to-do under the Channel, this
        screen is one Thread's detail. The Client never adds Threads up to
        reach the badge — that would only count the Threads it happened to
        load, and the number would move as the reader navigates. */}
    <p className={css.boardNote!}>{t('humanTodoBoardScope')}</p>
    {error !== undefined && <p className={css.todoError!} role="alert">{error}</p>}
    {notice !== undefined && <p className={css.todoStatus!} role="status" aria-live="polite">{notice}</p>}
    {todos.length === 0 && error === undefined && <p className={css.todoEmpty}>{t('humanTodosEmpty')}</p>}
    <div className={css.todoList}>
      {todos.map(todo => {
        const state = listedState(todo)
        // A settled to-do stays readable but offers nothing: the ledger has no
        // transition out of closed, and the Human would only be pressing a
        // button the Host refuses.
        const settled = todo.state === 'closed' || todo.state === 'cancelled'
        const claimedBy = todo.claimedBy
        const at = times(todo)
        const requester = memberName(todo.requester)
        return <article
          className={css.todoCard}
          data-state={state}
          data-todo-card={todo.todoRef}
          key={todo.todoRef}
          ref={flashedTodoRef === todo.todoRef ? flashedRef : undefined}
          {...(flashedTodoRef === todo.todoRef ? { 'data-flash': '' } : {})}
        >
          <div className={css.todoHead}>
            <MemberSeat memberId={todo.requester} label={requester} size="list" />
            <div className={css.todoHeadCopy}>
              <div className={css.todoTitleRow}>
                <span className={css.todoTitle}>{todo.title}</span>
                <span className={css.stateTag} data-state={state} data-todo-state-tag={state}>
                  <span className={css.dot} aria-hidden="true" />{t(stateKey(state))}
                </span>
              </div>
              <div className={css.todoOrigin}>{taskNumber === undefined
                ? t('humanTodoDispatchedBy', { requester: requester.replace(/^@/, ''), time: at.dispatchedAt === undefined ? t('timeUnknown') : formatAbsoluteTime(at.dispatchedAt) })
                : t('humanTodoDispatchedUnderTask', { requester: requester.replace(/^@/, ''), time: at.dispatchedAt === undefined ? t('timeUnknown') : formatAbsoluteTime(at.dispatchedAt), number: taskNumber })}</div>
            </div>
          </div>
          <div className={css.todoFoot}>
            {claimedBy !== undefined && <span className={css.todoActor} data-todo-claimed-by="">
              <MemberSeat memberId={claimedBy} label={memberName(claimedBy)} size="row" />
              {at.claimedAt === undefined
                ? <span>{t('humanTodoClaimedByName', { name: memberName(claimedBy) })}</span>
                : <span>{t('humanTodoClaimedBy', { name: memberName(claimedBy), time: formatAbsoluteTime(at.claimedAt) })}</span>}
            </span>}
            <span className={css.todoFootGrow} />
            {!settled && <>
              {/* Claiming marks and shows, and that is the whole effect: it
                  never excludes another reader, so the button stays available
                  as the idempotent repeat rather than becoming disabled. */}
              <Button size="sm" variant={state === 'pending' ? 'outline' : 'ghost'} disabled={pending}
                aria-pressed={claimedBy !== undefined}
                onClick={() => { onClaim(todo) }}>{t('humanTodoClaim')}</Button>
              <Button size="sm" variant="primary" disabled={pending} onClick={() => { onAnswer(todo) }}>{t('humanTodoAnswer')}</Button>
              {/* The requester may close its own ask and so may the Human; the
                  ledger lets a Human close a pending to-do too, because
                  withdrawing is the requester's move and the Human has none. */}
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => { onClose(todo) }}>{t('humanTodoClose')}</Button>
            </>}
          </div>
          {todo.answeredMessageRef !== undefined && <div className={css.answerCard}>
            <b>{t('humanTodoAnswer')}</b>
            <span>{t('humanTodoAnsweredNotice')}</span>
          </div>}
        </article>
      })}
    </div>
  </div>
}

/**
 * The mark on the Thread message that answered a to-do. It sits under the body
 * it belongs to and names the to-do, so the reader can go back to the entry the
 * answer settled instead of hunting for it in the list.
 */
export function HumanTodoAnswerMark({ todo, onOpen, t }: {
  readonly todo: AgentTeamHumanTodo
  readonly onOpen: (todoRef: AgentTeamHumanTodoRef) => void
  readonly t: TeamConversationProps['t']
}) {
  return <button type="button" className={css.answerMark} data-todo-answer-mark={todo.todoRef}
    onClick={() => { onOpen(todo.todoRef) }}>
    {t('humanTodoAnswerBound', { title: todo.title })}
  </button>
}

/**
 * The answering targets keyed by the Message that answered each one: one
 * message answers at most one to-do, so the Message ref is the key and a row
 * can look itself up without scanning the list on every render.
 */
export function useAnsweredTodos(todos: readonly AgentTeamHumanTodo[]): ReadonlyMap<AgentTeamMessageRef, AgentTeamHumanTodo> {
  return useMemo(() => {
    const byMessage = new Map<AgentTeamMessageRef, AgentTeamHumanTodo>()
    for (const todo of todos) if (todo.answeredMessageRef !== undefined) byMessage.set(todo.answeredMessageRef, todo)
    return byMessage
  }, [todos])
}

/** The Channel-row badge: the Host's own per-Channel count, never a Client sum. */
export function HumanTodoCountBadge({ count, t }: { readonly count: number; readonly t: TeamConversationProps['t'] }) {
  // Zero is the absence of a count rather than a capsule reading zero, which is
  // the shared capsule's own rule too.
  if (count <= 0) return null
  return <TeamCountBadge count={count} tone="human" label={t('humanTodoNeedsMe', { count })} />
}
