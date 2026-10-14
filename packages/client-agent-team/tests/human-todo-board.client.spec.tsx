// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, within } from '@testing-library/react'
import type { AgentTeamHumanTodo, AgentTeamHumanTodoRef, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { HumanTodoAnswerMark, HumanTodoBoard, HumanTodoCountBadge, isUnsettledTodo, listedState, useAnsweredTodos } from '../src/client/HumanTodoBoard.tsx'
import { zh } from '../src/client/locales.ts'
import type { TeamConversationProps } from '../src/client/slots.ts'

afterEach(cleanup)

// The board is a presentation surface: it reads the Host's facts and names the
// target state. These specs therefore drive it with plain props rather than a
// runtime, which is also what keeps them able to say what the reader sees.
const t = ((key: string, values?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return values === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`))
}) as TeamConversationProps['t']

function todo(overrides: Partial<AgentTeamHumanTodo> & { todoRef: string }): AgentTeamHumanTodo {
  return {
    workspaceId: 'ws-1',
    channelRef: 'channel:1',
    threadRef: 'thread:1',
    title: '请确认发布顺序',
    state: 'pending',
    requester: 'member:a' as AgentTeamMemberId,
    ...overrides,
    // The ref is branded, and a spec writes it as a plain string for legibility.
    todoRef: overrides.todoRef as AgentTeamHumanTodoRef,
  } as unknown as AgentTeamHumanTodo
}

const noTimes = () => ({})
const nameOf = (memberId: AgentTeamMemberId) => `@${memberId.replace(/^member:/, '')}`

/** The board element alone, so a spec can re-render it in place and watch one state change. */
function boardElement(todos: readonly AgentTeamHumanTodo[], extra: Partial<Parameters<typeof HumanTodoBoard>[0]> = {}) {
  return <HumanTodoBoard
    workspaceId={'ws-1' as never}
    humanName="@jzp"
    todos={todos}
    loading={false}
    pending={false}
    memberName={nameOf}
    times={noTimes}
    onClaim={vi.fn()}
    onAnswer={vi.fn()}
    onClose={vi.fn()}
    t={t}
    {...extra}
  />
}

function board(todos: readonly AgentTeamHumanTodo[], extra: Partial<Parameters<typeof HumanTodoBoard>[0]> = {}) {
  return render(boardElement(todos, extra))
}

/** A to-do ref as the ledger brands it; a spec writes the plain string. */
const ref = (value: string): AgentTeamHumanTodoRef => value as AgentTeamHumanTodoRef

function card(container: HTMLElement, todoRef: string): HTMLElement {
  const found = container.querySelector(`[data-todo-card="${todoRef}"]`)
  expect(found).not.toBeNull()
  return found as HTMLElement
}

function actionLabels(element: HTMLElement): string[] {
  return [...element.querySelectorAll('button')].map(button => button.textContent ?? '')
}

describe('HumanTodoBoard — the four listed states (E1/E2, S8)', () => {
  it('prints a text word for every state, so colour is never the only carrier', () => {
    const { container } = board([
      todo({ todoRef: ref('todo:1'), state: 'pending' }),
      todo({ todoRef: ref('todo:2'), state: 'claimed', claimedBy: 'member:b' as AgentTeamMemberId }),
      todo({ todoRef: ref('todo:3'), state: 'answered', answeredMessageRef: 'message:9' as never }),
      todo({ todoRef: ref('todo:4'), state: 'closed' }),
    ])
    const words = ['pending', 'claimed', 'answered', 'closed'].map(state =>
      container.querySelector(`[data-todo-state-tag="${state}"]`)?.textContent)
    expect(words).toEqual([zh.humanTodoStatePending, zh.humanTodoStateClaimed, zh.humanTodoStateAnswered, zh.humanTodoStateClosed])
    // A dot rides along as decoration; it never carries the state by itself.
    expect(container.querySelectorAll('[data-todo-state-tag] [aria-hidden="true"]')).toHaveLength(4)
  })

  it('lists a withdrawn to-do as closed rather than inventing a fifth word', () => {
    // The Host keeps a cancelled to-do out of the list, but if one arrives the
    // card must not print a state the reader cannot act on.
    expect(listedState(todo({ todoRef: ref('todo:1'), state: 'cancelled' }))).toBe('closed')
    expect(listedState(todo({ todoRef: ref('todo:2'), state: 'pending' }))).toBe('pending')
  })
})

describe('HumanTodoBoard — which actions a card offers (E7/E8/E9)', () => {
  it('offers the three Human actions on all three unsettled states', () => {
    const { container } = board([
      todo({ todoRef: ref('todo:1'), state: 'pending' }),
      todo({ todoRef: ref('todo:2'), state: 'claimed', claimedBy: 'member:b' as AgentTeamMemberId }),
      todo({ todoRef: ref('todo:3'), state: 'answered' }),
    ])
    for (const ref of ['todo:1', 'todo:2', 'todo:3']) {
      expect(actionLabels(card(container, ref))).toEqual([zh.humanTodoClaim, zh.humanTodoAnswer, zh.humanTodoClose])
    }
  })

  it('offers nothing at all on a settled card, which is how the group folds away', () => {
    const { container } = board([todo({ todoRef: ref('todo:4'), state: 'closed' })])
    const settled = card(container, 'todo:4')
    expect(actionLabels(settled)).toEqual([])
    // Folded away is not the same as deleted: the entry stays on the list.
    expect(settled.textContent).toContain('请确认发布顺序')
  })

  it('never grows an entry for the two actions this batch does not implement', () => {
    const { container } = board([todo({ todoRef: ref('todo:1') })])
    expect(container.textContent).not.toContain('新建待办')
    expect(container.textContent).not.toContain('取消认领')
  })

  it('keeps the entry listed after it is settled, with its answer still named', () => {
    const answered = todo({ todoRef: ref('todo:3'), state: 'answered', answeredMessageRef: 'message:9' as never })
    const { container } = board([answered])
    expect(card(container, 'todo:3').textContent).toContain('请确认发布顺序')
    expect(container.textContent).toContain(zh.humanTodoAnsweredNotice)
  })
})

describe('HumanTodoBoard — durable claim, no un-claim (E4)', () => {
  it('keeps Claim available as the repeat instead of disabling it, since claiming excludes nobody', () => {
    const { container } = board([
      todo({ todoRef: ref('todo:1'), state: 'pending' }),
      todo({ todoRef: ref('todo:2'), state: 'claimed', claimedBy: 'member:b' as AgentTeamMemberId }),
    ])
    const claimButton = (element: HTMLElement): HTMLButtonElement =>
      [...element.querySelectorAll('button')].find(button => button.textContent === zh.humanTodoClaim) as HTMLButtonElement
    const [pendingClaim, claimedClaim] = [card(container, 'todo:1'), card(container, 'todo:2')].map(claimButton) as [HTMLButtonElement, HTMLButtonElement]
    expect(pendingClaim.disabled).toBe(false)
    expect(claimedClaim.disabled).toBe(false)
    // Pressed says "this is claimed"; the mark stays available as the repeat.
    expect(pendingClaim.getAttribute('aria-pressed')).toBe('false')
    expect(claimedClaim.getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).not.toContain('取消认领')
  })

  it('names who claimed it, so "claimed" is attributable and not just a word', () => {
    const { container } = board([todo({ todoRef: ref('todo:2'), state: 'claimed', claimedBy: 'member:b' as AgentTeamMemberId })])
    expect(card(container, 'todo:2').querySelector('[data-todo-claimed-by]')?.textContent).toContain('@b')
  })
})

describe('HumanTodoBoard — feedback and idempotence (S5)', () => {
  it('reports a repeat through a polite status region rather than an alert', () => {
    const { container } = board([todo({ todoRef: ref('todo:1') })], { notice: zh.humanTodoClaimAlready })
    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toBe(zh.humanTodoClaimAlready)
    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('reserves the alert role for a failed read, which does interrupt', () => {
    const { container } = board([], { error: '账本读取失败' })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('账本读取失败')
  })

  it('says a to-do is already settled when one is closed twice', () => {
    const { container } = board([todo({ todoRef: ref('todo:1') })], { notice: zh.humanTodoCloseAlready })
    expect(container.querySelector('[role="status"]')?.textContent).toBe(zh.humanTodoCloseAlready)
  })
})

describe('HumanTodoBoard — disabled while a mutation is in flight (E6)', () => {
  it('disables every action on the card while the Host has not answered', () => {
    const { container } = board([todo({ todoRef: ref('todo:1') })], { pending: true })
    const buttons = [...card(container, 'todo:1').querySelectorAll('button')]
    expect(buttons).toHaveLength(3)
    expect(buttons.every(button => button.disabled)).toBe(true)
  })

  it('leaves the buttons in place while pending, so focus is not thrown away', () => {
    const { container } = board([todo({ todoRef: ref('todo:1') })])
    const before = [...card(container, 'todo:1').querySelectorAll('button')]
    cleanup()
    const { container: pendingContainer } = board([todo({ todoRef: ref('todo:1') })], { pending: true })
    const after = [...card(pendingContainer, 'todo:1').querySelectorAll('button')]
    // Same order and same identity of labels: the action group changes shape
    // only when the state changes, never merely because a press is in flight.
    expect(after.map(button => button.textContent)).toEqual(before.map(button => button.textContent))
  })

  it('keeps focus on the Claim button once the state reaches claimed', () => {
    // The reader presses Claim, the Host records it, and the parent re-renders
    // with the new facts. The action group changes shape here — that is what
    // makes the claim worth pinning: a remount inside the group would drop
    // focus to <body> and cost the reader their place in the list.
    const onClaim = vi.fn()
    const { container, rerender } = render(boardElement([todo({ todoRef: ref('todo:1') })], { onClaim }))
    const claim = within(card(container, 'todo:1')).getByRole('button', { name: zh.humanTodoClaim })

    claim.focus()
    // Self-evidence first: jsdom really does hand this node the focus, so a
    // later "no focus" reading means the node was replaced, not that focus
    // never worked here.
    expect(document.activeElement).toBe(claim)
    claim.click()
    expect(onClaim).toHaveBeenCalledTimes(1)

    rerender(boardElement([todo({ todoRef: ref('todo:1'), state: 'claimed', claimedBy: 'member:human' as AgentTeamMemberId })]))
    // The state really moved, so the assertions below are about a changed group.
    expect(card(container, 'todo:1').querySelector('[data-todo-state-tag]')?.getAttribute('data-todo-state-tag')).toBe('claimed')
    expect(within(card(container, 'todo:1')).getByRole('button', { name: zh.humanTodoClaim }).getAttribute('aria-pressed')).toBe('true')

    const after = within(card(container, 'todo:1')).getByRole('button', { name: zh.humanTodoClaim })
    expect(after.isSameNode(claim)).toBe(true)
    expect(document.activeElement).toBe(claim)
    expect(document.activeElement).not.toBe(document.body)
  })
})

describe('HumanTodoBoard — calling back with the entry the reader touched', () => {
  it('hands each action its own to-do', () => {
    const onClaim = vi.fn()
    const onAnswer = vi.fn()
    const onClose = vi.fn()
    const entry = todo({ todoRef: ref('todo:7') })
    const { container } = board([entry], { onClaim, onAnswer, onClose })
    const buttons = [...card(container, 'todo:7').querySelectorAll('button')]
    buttons.forEach(button => { (button as HTMLButtonElement).click() })
    expect(onClaim).toHaveBeenCalledWith(entry)
    expect(onAnswer).toHaveBeenCalledWith(entry)
    expect(onClose).toHaveBeenCalledWith(entry)
  })
})

describe('HumanTodoBoard — scope note and empty state (E3)', () => {
  it('states that this screen is one Thread while the Channel number is the whole Channel', () => {
    const { container } = board([todo({ todoRef: ref('todo:1') })])
    expect(container.querySelector('[data-view-panel="board"]')).not.toBeNull()
    expect(container.textContent).toContain(zh.humanTodoBoardScope)
  })

  it('says the list is empty rather than rendering a bare panel', () => {
    const { container } = board([])
    expect(container.textContent).toContain(zh.humanTodosEmpty)
  })

  it('marks the panel busy before the first answer instead of claiming emptiness', () => {
    const { container } = board([], { loading: true })
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(container.textContent).not.toContain(zh.humanTodosEmpty)
  })
})

describe('HumanTodoBoard — the origin line', () => {
  it('omits the instant rather than inventing one when the Thread has no matching fact', () => {
    const { container } = board([todo({ todoRef: ref('todo:1') })])
    expect(card(container, 'todo:1').textContent).toContain(zh.timeUnknown)
  })

  it('prints the resolved instant once the Thread facts supply one', () => {
    const { container } = board([todo({ todoRef: ref('todo:1') })], {
      times: () => ({ dispatchedAt: '2026-10-14T04:00:00.000Z' }),
    })
    expect(card(container, 'todo:1').textContent).not.toContain(zh.timeUnknown)
  })

  it('names the Task when the Thread carries one', () => {
    const { container } = board([todo({ todoRef: ref('todo:1') })], { taskNumber: 41 })
    expect(card(container, 'todo:1').textContent).toContain('41')
  })
})

describe('isUnsettledTodo — the badge counts exactly these (S2)', () => {
  it('counts the three unsettled states and not the settled ones', () => {
    expect(['pending', 'claimed', 'answered'].map(state => isUnsettledTodo(todo({ todoRef: ref('todo:x'), state: state as never }))))
      .toEqual([true, true, true])
    expect(['closed', 'cancelled'].map(state => isUnsettledTodo(todo({ todoRef: ref('todo:x'), state: state as never }))))
      .toEqual([false, false])
  })
})

describe('HumanTodoAnswerMark — the mark on the answering message', () => {
  it('is a reachable control that names the to-do it settled', () => {
    const onOpen = vi.fn()
    const { container } = render(<HumanTodoAnswerMark todo={todo({ todoRef: ref('todo:3') })} onOpen={onOpen} t={t} />)
    const mark = container.querySelector('[data-todo-answer-mark="todo:3"]') as HTMLButtonElement
    expect(mark.tagName).toBe('BUTTON')
    expect(mark.textContent).toContain('请确认发布顺序')
    mark.click()
    expect(onOpen).toHaveBeenCalledWith('todo:3')
  })
})

describe('useAnsweredTodos — the index the timeline reads', () => {
  it('keys answering targets by the message that answered them', () => {
    function Probe({ todos }: { readonly todos: readonly AgentTeamHumanTodo[] }) {
      const index = useAnsweredTodos(todos)
      return <span data-probe="">{[...index.keys()].join(',')}</span>
    }
    const { container } = render(<Probe todos={[
      todo({ todoRef: ref('todo:1'), state: 'answered', answeredMessageRef: 'message:9' as never }),
      todo({ todoRef: ref('todo:2'), state: 'pending' }),
    ]} />)
    // An unanswered entry contributes no key: one message answers at most one
    // to-do, so the Message ref is the whole key.
    expect(container.querySelector('[data-probe]')?.textContent).toBe('message:9')
  })

  it('ignores a to-do whose answer is not bound to a message yet', () => {
    function Probe({ todos }: { readonly todos: readonly AgentTeamHumanTodo[] }) {
      const index = useAnsweredTodos(todos)
      return <span data-probe="">{[...index.keys()].join(',')}</span>
    }
    const { container } = render(<Probe todos={[todo({ todoRef: ref('todo:1'), state: 'answered' })]} />)
    expect(container.querySelector('[data-probe]')?.textContent).toBe('')
  })
})

describe('HumanTodoCountBadge — the number is in the control that owns it (S2)', () => {
  it('draws nothing at zero, because zero is the absence of a count', () => {
    const { container } = render(<HumanTodoCountBadge count={0} t={t} />)
    expect(container.textContent).toBe('')
  })

  it('draws the number for an unsettled Channel', () => {
    const { container } = render(<HumanTodoCountBadge count={2} t={t} />)
    expect(container.textContent).toBe('2')
  })

  it('caps a wide count so the capsule never grows', () => {
    const { container } = render(<HumanTodoCountBadge count={120} t={t} />)
    expect(container.textContent).toBe('99+')
  })
})

describe('listedState and the to-do ref are the card identity', () => {
  it('carries the state on the card as well as on the tag', () => {
    const { container } = board([todo({ todoRef: ref('todo:2'), state: 'claimed', claimedBy: 'member:b' as AgentTeamMemberId })])
    expect(card(container, 'todo:2').getAttribute('data-state')).toBe('claimed')
    expect(card(container, 'todo:2').querySelector('[data-todo-state-tag]')?.getAttribute('data-state')).toBe('claimed')
  })

  it('marks the entry the reader jumped to, and only that one', () => {
    // jsdom has no layout engine and resolves no stylesheet, so the jump is read
    // through a seam. The card sits in `css.todoList` inside the scrolling
    // `css.board`, and the board is found by walking up to the nearest
    // scrollable ancestor — but jsdom reports every element's `overflow-y` as
    // `visible`, so that walk finds nothing and a test written naively would
    // pass vacuously. The seam therefore supplies both halves the container test
    // needs: a scrolling overflow on the board, and a real scroll range.
    //
    // The assertion is on the VALUE written, not on the fact that a write
    // happened: the board's pin-to-bottom policy writes `scrollTop` too, so a
    // "was it written at all" assertion would stay green with the jump removed.
    const boardOf = () => document.querySelector('div[data-view-panel="board"]') as HTMLElement | null
    const centredValues: number[] = []
    const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    const originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
    const originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
    const originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
    const originalComputedStyle = window.getComputedStyle
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element): number { return 0 },
      set(this: Element, value: number): void { if (this === boardOf()) centredValues.push(value) },
    })
    // The jumped-to card is 500px down a 400px-tall box and 100px tall, so
    // centring it writes `500 - 400 / 2 + 100 / 2` = 350.
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement): number { return this.dataset.todoCard === 'todo:2' ? 500 : 0 },
    })
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get(this: Element): number {
        if (this === boardOf()) return 400
        return (this as HTMLElement).dataset?.todoCard === 'todo:2' ? 100 : 0
      },
    })
    // The range that makes the board a scroller at all: without it the walk
    // rejects the board and the jump is correctly a no-op.
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get(this: Element): number { return this === boardOf() ? 2000 : 0 },
    })
    // Only the board reports a scrolling overflow; every other ancestor keeps
    // jsdom's own answer so the walk has exactly one box to find.
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      const style = originalComputedStyle.call(window, element, pseudo ?? undefined)
      if (element !== boardOf()) return style
      return new Proxy(style, {
        get(target, property, receiver): unknown {
          return property === 'overflowY' ? 'auto' : Reflect.get(target, property, receiver)
        },
      })
    }) as typeof window.getComputedStyle
    try {
      const { container } = board(
        [todo({ todoRef: ref('todo:1') }), todo({ todoRef: ref('todo:2') })],
        { flashedTodoRef: 'todo:2' as unknown as AgentTeamTodoUnknown },
      )
      expect(card(container, 'todo:2').hasAttribute('data-flash')).toBe(true)
      expect(card(container, 'todo:1').hasAttribute('data-flash')).toBe(false)
      // The jump centred the card in the board's own scroll position...
      expect(centredValues).toContain(350)
      // ...and moved no other box on the way there.
      expect(centredValues).toHaveLength(1)
    } finally {
      if (originalScrollTop === undefined) delete (Element.prototype as { scrollTop?: unknown }).scrollTop
      else Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop)
      if (originalOffsetTop === undefined) delete (HTMLElement.prototype as { offsetTop?: unknown }).offsetTop
      else Object.defineProperty(HTMLElement.prototype, 'offsetTop', originalOffsetTop)
      if (originalClientHeight === undefined) delete (Element.prototype as { clientHeight?: unknown }).clientHeight
      else Object.defineProperty(Element.prototype, 'clientHeight', originalClientHeight)
      if (originalScrollHeight === undefined) delete (Element.prototype as { scrollHeight?: unknown }).scrollHeight
      else Object.defineProperty(Element.prototype, 'scrollHeight', originalScrollHeight)
      window.getComputedStyle = originalComputedStyle
    }
  })
})

type AgentTeamTodoUnknown = AgentTeamHumanTodoRef
