/**
 * Bot messages inside the Harness conversation view. Without this, the Chat
 * view shows each one as a generic "notification" row with the raw wrapper.
 * A Conversation node Definition claims `user/message` events whose source is
 * `futurebot` and renders them as one compact row: who sent work, who
 * answered, what the group said, which files changed.
 */
import { useState } from 'react'
import type { Translate } from './i18n.ts'
import type { RelayState, RelayView } from './relay.ts'

const CSS = `
.obr { margin: 4px 0; border-left: 2px solid var(--dsw-alias-border-l3); padding: 2px 0 2px 10px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.6; }
.obr--reply { border-left-color: var(--dsw-alias-state-business-primary); }
.obr--failed { border-left-color: var(--dsw-alias-state-error-primary); }
.obr__head { display: flex; align-items: baseline; gap: 6px; cursor: pointer; user-select: none; }
.obr__head strong { color: var(--dsw-alias-label-primary); font-weight: 600; }
.obr__toggle { margin-left: auto; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.obr__body { margin: 4px 0 0; white-space: pre-wrap; color: var(--dsw-alias-label-primary); max-height: 320px; overflow: auto; }
.obr__preview { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`

function headline(view: RelayView, t: Translate): string {
  switch (view.kind) {
    case 'request': return t(view.expectReply === false ? 'relayNote' : 'relayRequest', { name: view.name ?? '?' })
    case 'reply': return t(view.status === 'returned' ? 'relayReply' : 'relayReplyFailed', { name: view.name ?? '?' })
    case 'group': return t('relayGroup', { title: view.title ?? '' })
    case 'evidence': return t('relayEvidence', { folder: view.folder ?? '' })
    default: return t('relayNotice')
  }
}

export function RelayRow({ node, t }: { node: { data: RelayState }; t: Translate }) {
  const view = node.data
  const [open, setOpen] = useState(false)
  const preview = view.body.split('\n').find(line => line.trim() !== '') ?? ''
  const tone = view.kind === 'reply' ? (view.status === 'returned' ? ' obr--reply' : ' obr--failed') : ''
  return (
    <div className={`obr${tone}`}>
      <style>{CSS}</style>
      <div className="obr__head" role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(value => !value) } }}>
        <strong>{headline(view, t)}</strong>
        <span className="obr__toggle">{open ? t('relayHide') : t('relayShow')}</span>
      </div>
      {open ? <p className="obr__body">{view.body}</p> : preview !== '' && <p className="obr__preview">{preview}</p>}
    </div>
  )
}
