import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from '../src/shared/types.ts'
import { MIND_LIMITS, Mind, MindError, type AgendaItem, type MemoryEntry, type Table } from '../src/host/mind.ts'

class Memory<T> implements Table<T> {
  rows = new Map<string, T>()
  get(id: string) { return this.rows.get(id) }
  entries() { return [...this.rows.entries()] }
  async put(id: string, value: T) { this.rows.set(id, value) }
  async delete(id: string) { return this.rows.delete(id) }
}

const stamp = '2026-11-08T00:00:00.000Z'
const bot = (id: string, name: string): Bot => ({ id, name, instructions: '', permission: 'auto', workspace: `/w/${id}`, sessionId: `s-${id}`, createdAt: stamp, updatedAt: stamp, rev: 1 })

let memory: Memory<MemoryEntry>
let agenda: Memory<AgendaItem>
let mind: Mind
let clock: number

beforeEach(() => {
  memory = new Memory()
  agenda = new Memory()
  clock = Date.UTC(2026, 10, 8)
  let n = 0
  mind = new Mind(memory, agenda, () => [bot('lin', '林分析'), bot('zhao', 'Zhao')], {
    now: () => new Date(clock += 1000),
    newId: prefix => `${prefix}${++n}`,
  })
})

const fails = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: unknown) => (e instanceof MindError ? e.message : `unexpected ${String(e)}`))

describe('memory', () => {
  it('keeps records, inferences and corrections apart, with who they are about and where they were written', async () => {
    const record = await mind.note('lin', { kind: 'record', text: 'User asked for DE with p < 0.05.', about: 'user' }, 's-lin')
    expect(record).toMatchObject({ id: 'm1', bot: 'lin', kind: 'record', about: 'user', session: 's-lin' })
    const guess = await mind.note('lin', { kind: 'inference', text: 'Welch t-test is fine for this.' })
    const fix = await mind.note('lin', { kind: 'correction', text: 'Counts need a count model (DESeq2), not a t-test.', corrects: guess.id })
    expect(fix.corrects).toBe('m2')
    expect(memory.get('m2')!.correctedBy).toBe('m3')
    const aboutZhao = await mind.note('lin', { kind: 'record', text: 'Zhao prefers bullet points.', about: 'zhao' })
    expect(aboutZhao.about).toBe('zhao')
  })

  it('refuses bad notes', async () => {
    expect(await fails(mind.note('lin', { kind: 'guess', text: 'x' }))).toContain('kind must be')
    expect(await fails(mind.note('lin', { kind: 'record', text: '  ' }))).toContain('text must be')
    expect(await fails(mind.note('lin', { kind: 'record', text: 'x'.repeat(MIND_LIMITS.entryLength + 1) }))).toContain('text must be')
    expect(await fails(mind.note('lin', { kind: 'record', text: 'x', about: 'nobody' }))).toContain('no bot named nobody')
    expect(await fails(mind.note('lin', { kind: 'record', text: 'x', about: '林分析' }))).toContain('someone else')
    expect(await fails(mind.note('lin', { kind: 'correction', text: 'x' }))).toContain('names the entry')
    const other = await mind.note('zhao', { kind: 'record', text: 'mine' })
    expect(await fails(mind.note('lin', { kind: 'correction', text: 'x', corrects: other.id }))).toContain('no memory entry')
  })

  it('searches every word, newest first, including replaced entries and who they are about', async () => {
    await mind.note('lin', { kind: 'record', text: 'Ran DESeq2 on day 3 counts.' })
    await mind.note('lin', { kind: 'record', text: 'Ran DESeq2 on day 7 counts.' })
    await mind.note('lin', { kind: 'record', text: 'Zhao wants English only.', about: 'Zhao' })
    expect(mind.search('lin', 'deseq2 counts').map(e => e.text)).toEqual(['Ran DESeq2 on day 7 counts.', 'Ran DESeq2 on day 3 counts.'])
    expect(mind.search('lin', 'zhao english')).toHaveLength(1)
    expect(mind.search('lin', undefined, 1)).toHaveLength(1)
    expect(mind.search('zhao', 'deseq2')).toEqual([])
  })

  it('digests corrections first, then collaborators, conclusions and records, within a size budget', async () => {
    expect(mind.memoryDigest('lin')).toContain('Your memory is empty')
    const guess = await mind.note('lin', { kind: 'inference', text: 'A t-test is enough.' })
    await mind.note('lin', { kind: 'correction', text: 'Use a count model for counts.', corrects: guess.id })
    await mind.note('lin', { kind: 'record', text: 'User reads Chinese.', about: 'user' })
    await mind.note('lin', { kind: 'record', text: 'Zhao answers fast.', about: 'zhao' })
    await mind.note('lin', { kind: 'inference', text: 'Day 7 is the key timepoint.' })
    await mind.note('lin', { kind: 'record', text: 'Ran QC.' })
    const digest = mind.memoryDigest('lin')
    const order = ['Corrections:', 'About the user:', 'About Zhao:', 'What you have concluded:', 'Recent records:'].map(h => digest.indexOf(h))
    expect(order.every(at => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(digest).toContain('(corrects m1)')
    expect(digest).not.toContain('A t-test is enough.')
    expect(digest).toContain('1 more entries, including replaced ones')
    for (let i = 0; i < 60; i++) await mind.note('lin', { kind: 'record', text: `note ${i} ${'x'.repeat(200)}` })
    expect(mind.memoryDigest('lin').length).toBeLessThanOrEqual(MIND_LIMITS.digestChars + 80)
  })

  it('can be replaced wholesale for a controlled comparison, without touching the bot it was copied from', async () => {
    const guess = await mind.note('zhao', { kind: 'inference', text: 'mean is fine' })
    await mind.note('zhao', { kind: 'correction', text: 'use the median', corrects: guess.id })
    await mind.note('lin', { kind: 'record', text: 'old' })
    await mind.replaceMemory('lin', mind.entries('zhao').map(({ bot: _b, ...entry }) => entry))
    const copied = mind.entries('lin')
    expect(copied.map(e => e.text)).toEqual(['mean is fine', 'use the median'])
    expect(copied.every(e => e.bot === 'lin' && !['m1', 'm2'].includes(e.id))).toBe(true)
    expect(copied[1]!.corrects).toBe(copied[0]!.id)
    expect(copied[0]!.correctedBy).toBe(copied[1]!.id)
    expect(mind.entries('zhao').map(e => e.id)).toEqual(['m1', 'm2'])
    await expect(mind.replaceMemory('lin', [{ id: 'x', kind: 'guess' as never, text: 'x', at: stamp }])).rejects.toThrow(/each entry needs/)
    await mind.replaceMemory('lin', [])
    expect(mind.entries('lin')).toEqual([])
  })

  it('prunes the oldest records first and never corrections', async () => {
    const guess = await mind.note('lin', { kind: 'inference', text: 'g' })
    await mind.note('lin', { kind: 'correction', text: 'c', corrects: guess.id })
    for (let i = 0; i < MIND_LIMITS.entriesPerBot; i++) await mind.note('lin', { kind: 'record', text: `r${i}` })
    const left = mind.entries('lin')
    expect(left).toHaveLength(MIND_LIMITS.entriesPerBot)
    expect(left.some(e => e.kind === 'correction')).toBe(true)
    expect(left.some(e => e.text === 'r0')).toBe(false)
  })
})

describe('agenda', () => {
  it('adds, revises, reorders, finishes and drops goals, recording every reason', async () => {
    const a = await mind.plan('lin', { action: 'add', goal: 'QC day 3', reason: 'user asked' })
    const b = await mind.plan('lin', { action: 'add', goal: 'DE day 3 vs 0', reason: 'next step' })
    const c = await mind.plan('lin', { action: 'add', goal: 'Write report', reason: 'deliverable' })
    expect(mind.goals('lin').map(g => g.goal)).toEqual(['QC day 3', 'DE day 3 vs 0', 'Write report'])
    await mind.plan('lin', { action: 'revise', id: c.id, position: 1, reason: 'deadline moved up', trigger: 'message from user' })
    expect(mind.goals('lin').map(g => g.id)).toEqual([c.id, a.id, b.id])
    await mind.plan('lin', { action: 'revise', id: b.id, goal: 'DE day 7 vs 0', reason: 'day 7 data arrived', trigger: 'evidence: day7.csv' })
    await mind.plan('lin', { action: 'done', id: a.id, reason: 'QC passed' })
    await mind.plan('lin', { action: 'drop', id: c.id, reason: 'report no longer needed' })
    const goals = mind.goals('lin')
    expect(goals.map(g => [g.goal, g.state])).toEqual([['DE day 7 vs 0', 'open'], ['QC day 3', 'done'], ['Write report', 'dropped']])
    expect(goals[0]!.history.map(h => h.action)).toEqual(['add', 'revise'])
    expect(goals[0]!.history[1]).toMatchObject({ reason: 'day 7 data arrived', trigger: 'evidence: day7.csv', goal: 'DE day 7 vs 0' })
    expect(mind.agendaDigest('lin')).toBe(`Your agenda (open goals, in your order):\n1. [${b.id}] DE day 7 vs 0 (last revise: day 7 data arrived)`)
    await mind.plan('lin', { action: 'reopen', id: a.id, reason: 'QC must be redone', position: 1 })
    expect(mind.goals('lin').filter(g => g.state === 'open').map(g => g.id)).toEqual([a.id, b.id])
  })

  it('refuses changes without a reason, unknown goals and too many open goals', async () => {
    expect(await fails(mind.plan('lin', { action: 'add', goal: 'x', reason: '' }))).toContain('give a reason')
    expect(await fails(mind.plan('lin', { action: 'add', reason: 'why' }))).toContain('add needs a goal')
    expect(await fails(mind.plan('lin', { action: 'done', id: 'a99', reason: 'why' }))).toContain('no goal a99')
    expect(await fails(mind.plan('lin', { action: 'pause', reason: 'why' }))).toContain('action must be')
    const done = await mind.plan('lin', { action: 'add', goal: 'x', reason: 'why' })
    await mind.plan('lin', { action: 'done', id: done.id, reason: 'ok' })
    expect(await fails(mind.plan('lin', { action: 'revise', id: done.id, goal: 'y', reason: 'why' }))).toContain('reopen it first')
    expect(await fails(mind.plan('zhao', { action: 'drop', id: done.id, reason: 'not mine' }))).toContain('no goal')
    for (let i = 0; i < MIND_LIMITS.openGoals; i++) await mind.plan('zhao', { action: 'add', goal: `g${i}`, reason: 'planned' })
    expect(await fails(mind.plan('zhao', { action: 'add', goal: 'one more', reason: 'planned' }))).toContain('at most')
  })

  it('says when the agenda is empty', () => {
    expect(mind.agendaDigest('lin')).toContain('Your agenda is empty')
  })
})
