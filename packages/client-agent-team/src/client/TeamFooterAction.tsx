import { useSyncExternalStore } from 'react'
import { IconAgentPresetOutlineRegular, IconChevronLeftOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamFooterProps } from './slots.ts'
import css from './team.module.css'

/**
 * The Team entry at the sidebar's foot, beside Settings: one action that enters
 * the mode and, while the mode stands, names the way back to an ordinary
 * conversation. The mode's own marker on the document is the client's to keep
 * (see the mode-marker effect in `index.ts`), so this row draws the state it
 * reads and nothing else.
 * @param props - the foot's own share: the column state, the entry actions, and the locale.
 * @returns the entry row.
 */
export function TeamFooterAction({ wide, navigation, enterTeam, leaveTeam, t }: TeamFooterProps) {
  const state = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  const inTeam = state.mode === 'team'
  const label = inTeam ? t('backToConversations') : t('team')

  return (
    <div className={wide ? css.footerStack : `${css.footerStack} ${css.railStack}`}>
      <Tooltip label={label} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={wide ? css.footerAction : `${css.footerAction} ${css.rail}`}
          aria-label={label}
          data-team-action={inTeam ? 'leave' : 'enter'}
          onClick={inTeam ? leaveTeam : enterTeam}
        >
          {inTeam ? <IconChevronLeftOutlineRegular size={wide ? 16 : 18} /> : <IconAgentPresetOutlineRegular size={wide ? 16 : 18} />}
          {wide && <span>{label}</span>}
        </button>
      </Tooltip>
    </div>
  )
}
