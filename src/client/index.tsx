/**
 * futurebot browser half: a "Bots" entry in the sidebar panel list and the
 * page it opens in the main column (bots, their details, groups). A bot's
 * conversation opens in the Harness's own session view, so chatting with a
 * bot is chatting in Harness; messages between bots appear there as compact
 * rows instead of raw wrappers (conversation.tsx).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { api } from './api.ts'
import { BotsPage } from './BotsPage.tsx'
import { RelayRow } from './conversation.tsx'
import { RELAY_KIND, relayDefinition } from './relay.ts'
import { NS, dictionaries, type MessageKey, type Translate } from './i18n.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'futurebot': MessageKey
  }
}

const PANEL_ID = 'futurebots' as MainPanelId

function BotsIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="7" width="16" height="12" rx="4" />
      <circle cx="9.5" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <path d="M12 7V4" />
      <circle cx="12" cy="3.2" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

export const inject = ['slots', 'locale', 'uiWorkspace', 'uiConversation']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'futurebot: dictionaries')
  const t = ctx.locale.bind(NS) as Translate
  const openSession = (sessionId: string) => ctx.uiWorkspace.openSession(sessionId as unknown as SessionTarget)

  ctx.effect(function* () {
    yield ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      inject: () => ({ api, openSession, t }),
    }, BotsPage))
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 12,
      locale: NS,
      label: () => t('panel'),
    }, BotsIcon))
  }, 'futurebot: Bots page')

  ctx.effect(function* () {
    yield ctx.uiConversation.events.register(relayDefinition as never)
    yield ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node',
      key: RELAY_KIND as never,
      inject: () => ({ t }),
    } as never, RelayRow as never))
  }, 'futurebot: bot messages in conversations')
}
