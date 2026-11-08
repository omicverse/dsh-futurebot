import { describe, expect, it } from 'vitest'
import { searchOwn, type HistoryRecord } from '../src/host/history.ts'

const t = Date.UTC(2026, 10, 8, 3, 30)
const user = (seq: number, text: string, source: object = { kind: 'user' }): HistoryRecord => ({ type: 'user/message', seq, time: t + seq * 1000, data: { content: [{ type: 'text', text }], source } })
const said = (seq: number, text: string): HistoryRecord => ({ type: 'assistant/message', seq, time: t + seq * 1000, data: { message: { content: [{ type: 'text', text }] } } })

/** Pages of `size` records, newest page first, like the Harness. */
function port(records: HistoryRecord[], size = 3) {
  const calls: (number | undefined)[] = []
  return {
    calls,
    async page(_session: string, before: number | undefined) {
      calls.push(before)
      const older = records.filter(r => before === undefined || r.seq < before).sort((a, b) => a.seq - b.seq)
      const records_ = older.slice(-size)
      return { records: records_, hasMore: older.length > size }
    },
  }
}

describe('searchOwn', () => {
  const log = [
    user(1, 'Please run DESeq2 on the day 3 counts.'),
    said(2, 'Ran DESeq2: 41 genes at FDR 0.05.'),
    user(3, '<from_bot name="总管" bot_id="main" job="j1" reply="expected">\nRe-run DESeq2 with day 7.\n</from_bot>', { kind: 'futurebot', type: 'request' }),
    said(4, 'DESeq2 on day 7: 60 genes.'),
    user(5, '<evidence watch="w1" folder="/w">\nFiles changed\n- added: day9.csv\n</evidence>', { kind: 'futurebot', type: 'evidence' }),
    user(6, 'context snapshot mentioning DESeq2', { kind: 'system-prompt' }),
    { type: 'tool/result', seq: 7, time: t, data: {} },
  ]

  it('finds every-word matches newest first, saying who said them, across pages', async () => {
    const p = port(log)
    const found = await searchOwn(p, 's', 'deseq2 genes')
    expect(found.split('\n')).toEqual([
      '[#4 2026-11-08 03:30] you: DESeq2 on day 7: 60 genes.',
      '[#2 2026-11-08 03:30] you: Ran DESeq2: 41 genes at FDR 0.05.',
    ])
    expect(p.calls.length).toBeGreaterThan(1)
    expect(await searchOwn(port(log), 's', 'day 7')).toContain('总管: <from_bot')
    expect(await searchOwn(port(log), 's', 'day9')).toContain('evidence: <evidence')
    expect(await searchOwn(port(log), 's', 'snapshot')).toContain('Nothing in this conversation')
  })

  it('respects the limit and needs a query', async () => {
    expect((await searchOwn(port(log), 's', 'deseq2', 1)).split('\n')).toHaveLength(1)
    expect(await searchOwn(port(log), 's', '  ')).toBe('Give at least one word to search for.')
  })

  it('trims long matches around the first word', async () => {
    const long = `${'a '.repeat(300)}NEEDLE ${'b '.repeat(300)}`
    const found = await searchOwn(port([user(1, long)]), 's', 'needle')
    expect(found).toContain('NEEDLE')
    expect(found.length).toBeLessThan(400)
    expect(found).toContain('…')
  })
})
