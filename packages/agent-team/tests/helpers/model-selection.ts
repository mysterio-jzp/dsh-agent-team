import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'

/** Mount the Host selection fold, including consumption by a matching request. */
export function installFixtureModelSelection(ctx: Context): void {
  ctx.effect(() => ctx.sessionProjections.register({
    key: 'modelSelection',
    stateVersion: 2,
    init: () => ({ lastUsed: null as ModelSelection | null, pending: null as ModelSelection | null }),
    apply: (state: { lastUsed: ModelSelection | null; pending: ModelSelection | null }, event: SessionEvent) => {
      if (event.type === 'model/selection') return {
        lastUsed: state.lastUsed,
        pending: {
          provider: event.data.provider,
          model: event.data.model,
          ...event.data.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(event.data.reasoningEffort) },
        },
      }
      if (event.type !== 'request/header') return state
      const { provider, model, reasoningEffort } = event.data.header.config
      const logged = { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
      const consumed = state.pending !== null && state.pending.provider === provider
        && state.pending.model === model && state.pending.reasoningEffort === reasoningEffort
      return { lastUsed: logged, pending: consumed ? null : state.pending }
    },
  } as never), 'test.modelSelection')
}
