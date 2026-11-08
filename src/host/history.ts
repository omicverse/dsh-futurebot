/**
 * Looking back through a bot's own conversation. Most of it is already in
 * context, but compaction drops old turns; this reads the durable log.
 */

export interface HistoryRecord {
  type: string
  seq: number
  time: number
  data: unknown
}

export interface HistoryPort {
  /** One page of the log, older than `beforeSeq` when given. */
  page(sessionId: string, beforeSeq: number | undefined): Promise<{ records: readonly HistoryRecord[]; hasMore: boolean }>
}

export const HISTORY_LIMITS = { scan: 4000, snippet: 300, results: 20 } as const

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n')
}

/** Who said a record, in words, and what; undefined for anything but conversation. */
function speech(record: HistoryRecord): { who: string; text: string } | undefined {
  if (record.type === 'assistant/message') {
    const data = record.data as { message?: { content?: unknown } }
    const text = textOf(data.message?.content)
    return text === '' ? undefined : { who: 'you', text }
  }
  if (record.type !== 'user/message') return undefined
  const data = record.data as { content?: unknown; source?: { kind?: string; type?: string } }
  const text = textOf(data.content)
  if (text === '') return undefined
  const kind = data.source?.kind
  if (kind === 'user' || kind === undefined) return { who: 'user', text }
  if (kind !== 'futurebot') return undefined
  if (data.source?.type === 'evidence') return { who: 'evidence', text }
  const name = /name="([^"]*)"/.exec(text)?.[1]?.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
  return { who: name ?? 'another bot', text }
}

function snippet(text: string, term: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= HISTORY_LIMITS.snippet) return flat
  const at = Math.max(0, flat.toLocaleLowerCase().indexOf(term) - 80)
  const piece = flat.slice(at, at + HISTORY_LIMITS.snippet)
  return `${at > 0 ? '…' : ''}${piece}${at + HISTORY_LIMITS.snippet < flat.length ? '…' : ''}`
}

/**
 * Newest matches first. Every term must appear, ignoring case. Reads at most
 * HISTORY_LIMITS.scan records back.
 */
export async function searchOwn(port: HistoryPort, sessionId: string, query: string, limit = 8): Promise<string> {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(term => term !== '')
  if (terms.length === 0) return 'Give at least one word to search for.'
  const max = Math.max(1, Math.min(limit, HISTORY_LIMITS.results))
  const hits: string[] = []
  let before: number | undefined
  let scanned = 0
  while (hits.length < max && scanned < HISTORY_LIMITS.scan) {
    const page = await port.page(sessionId, before)
    if (page.records.length === 0) break
    const newestFirst = [...page.records].sort((a, b) => b.seq - a.seq)
    for (const record of newestFirst) {
      scanned += 1
      const said = speech(record)
      if (said === undefined) continue
      const lower = said.text.toLocaleLowerCase()
      if (!terms.every(term => lower.includes(term))) continue
      const when = new Date(record.time).toISOString().slice(0, 16).replace('T', ' ')
      hits.push(`[#${record.seq} ${when}] ${said.who}: ${snippet(said.text, terms[0]!)}`)
      if (hits.length >= max) break
    }
    if (!page.hasMore) break
    before = Math.min(...page.records.map(record => record.seq))
  }
  if (hits.length === 0) return `Nothing in this conversation's last ${scanned} records mentions ${terms.join(' ')}.`
  return hits.join('\n')
}
