/**
 * Turn the text of a message the plugin put into a bot conversation back
 * into what the conversation view shows. The Host writes the wrappers
 * (wrappers.ts, groups.ts, evidence.ts); this only reads them.
 */

export type RelayKind = 'request' | 'reply' | 'group' | 'evidence' | 'notice'

export interface RelayView {
  kind: RelayKind
  /** The other bot, for requests and replies. */
  name?: string
  /** Reply status: returned, failed, stopped or unknown. */
  status?: string
  expectReply?: boolean
  /** Group title, for group updates. */
  title?: string
  reason?: string
  /** Watched folder, for evidence. */
  folder?: string
  /** What the message says, without the wrapper. */
  body: string
}

function unescape(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of tag.matchAll(/([a-z_]+)="([^"]*)"/g)) out[match[1]!] = unescape(match[2]!)
  return out
}

function inner(text: string, tag: string): { attrs: Record<string, string>; body: string } | undefined {
  const open = new RegExp(`<${tag}\\b([^>]*)>`).exec(text)
  if (open === null) return undefined
  const start = open.index + open[0].length
  const end = text.indexOf(`</${tag}>`, start)
  const body = (end < 0 ? text.slice(start) : text.slice(start, end)).trim().replace(new RegExp(`&lt;/${tag}`, 'g'), `</${tag}`)
  return { attrs: attrs(open[1] ?? ''), body }
}

export function parseRelay(text: string, source: { type?: string; summary?: string } | undefined): RelayView {
  const type = source?.type
  if (type === 'notice') return { kind: 'notice', body: text.trim() }
  if (type === 'evidence') {
    const block = inner(text, 'evidence')
    return { kind: 'evidence', ...(block?.attrs.folder ? { folder: block.attrs.folder } : {}), body: block?.body ?? text.trim() }
  }
  if (type === 'group') {
    const block = inner(text, 'group_update')
    return {
      kind: 'group',
      ...(block?.attrs.title ? { title: block.attrs.title } : {}),
      ...(block?.attrs.reason ? { reason: block.attrs.reason } : {}),
      body: block?.body ?? text.trim(),
    }
  }
  if (type === 'reply') {
    const block = inner(text, 'bot_reply')
    return {
      kind: 'reply',
      ...(block?.attrs.name ? { name: block.attrs.name } : {}),
      status: block?.attrs.status ?? 'returned',
      body: block?.body ?? text.trim(),
    }
  }
  const block = inner(text, 'from_bot')
  return {
    kind: 'request',
    ...(block?.attrs.name ? { name: block.attrs.name } : {}),
    expectReply: block?.attrs.reply !== 'none',
    body: block?.body ?? text.trim(),
  }
}

/** The text blocks of a message's content, joined. */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n')
}

// ── The Conversation node Definition ─────────────────────────────────────
// Claims `user/message` events whose source is `futurebot`, so the Chat view
// shows one compact row (conversation.tsx) instead of a generic notification.

export const RELAY_KIND = 'futurebot-message'

export interface RelayState extends RelayView {
  seq: number
}

interface MatchEvent {
  type: string
  seq: number
  data: { id?: unknown; content?: unknown; source?: { kind?: string; type?: string; summary?: string } }
}

/** The Definition, typed loosely: it touches only stable event fields. */
export const relayDefinition = {
  kind: RELAY_KIND,
  target: 'chat',
  match: (event: MatchEvent) => (event.type === 'user/message' && event.data?.source?.kind === 'futurebot'
    ? { id: String(event.data.id ?? event.seq), role: 'start' as const, exclusive: true }
    : null),
  start: (_context: unknown, match: { event: MatchEvent }): RelayState => ({
    seq: match.event.seq,
    ...parseRelay(contentText(match.event.data.content), match.event.data.source),
  }),
  update: (context: { state: RelayState }) => context.state,
  buildViewNode: (context: { key: string; id: string; state?: RelayState; start?: { location?: unknown }; matches: { location?: unknown }[] }) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: RELAY_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      // Like the Harness's own notices: the input that opened (or joined) the turn.
      groupTree: 'input',
      data: context.state,
    }
  },
}


