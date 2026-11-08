import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from '../src/shared/types.ts'
import { WATCH_LIMITS, WatchError, Watcher, type EvidenceSource, type Watch } from '../src/host/evidence.ts'
import type { Table } from '../src/host/mind.ts'

class Memory<T> implements Table<T> {
  rows = new Map<string, T>()
  get(id: string) { return this.rows.get(id) }
  entries() { return [...this.rows.entries()] }
  async put(id: string, value: T) { this.rows.set(id, value) }
  async delete(id: string) { return this.rows.delete(id) }
}

const stamp = '2026-11-08T00:00:00.000Z'
const lin: Bot = { id: 'lin', name: '林分析', instructions: '', permission: 'auto', workspace: '/w', sessionId: 's-lin', createdAt: stamp, updatedAt: stamp, rev: 1 }

let dir: string
let table: Memory<Watch>
let woken: { session: string; text: string; source: EvidenceSource }[]
let busy: boolean
let now: number
let timers: { at: number; run: () => void }[]
let listeners: Map<string, (event: string, file: string | null) => void>
let closed: string[]
let watcher: Watcher

function advance(ms: number) {
  now += ms
  for (const timer of timers.filter(t => t.at <= now)) {
    timers.splice(timers.indexOf(timer), 1)
    timer.run()
  }
}

async function settle() { await new Promise(resolve => setTimeout(resolve, 0)) }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'futurebot-watch-'))
  table = new Memory()
  woken = []
  busy = false
  now = 1_000_000
  timers = []
  listeners = new Map()
  closed = []
  let n = 0
  watcher = new Watcher(table, {
    wake: async (session, text, source) => { woken.push({ session, text, source }) },
    busy: () => busy,
  }, id => (id === 'lin' ? lin : undefined), {
    now: () => now,
    newId: () => `w${++n}`,
    warn: () => undefined,
    watch: (path, _opts, listener) => { listeners.set(path, listener); return { close: () => { closed.push(path) }, on: () => undefined } as never },
    setTimer: (run, ms) => { const timer = { at: now + ms, run }; timers.push(timer); return timer },
    clearTimer: handle => { timers.splice(timers.indexOf(handle as never), 1) },
  })
})

afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('watching a folder', () => {
  it('wakes the idle bot once with what changed and why it was watching', async () => {
    const watch = await watcher.add('lin', dir, 'Day 7 counts land here.')
    expect(watch).toMatchObject({ id: 'w1', path: dir, note: 'Day 7 counts land here.' })
    await writeFile(join(dir, 'day7.csv'), 'x')
    const fire = listeners.get(dir)!
    fire('rename', 'day7.csv')
    fire('change', 'day7.csv')
    fire('change', 'notes.txt')
    fire('rename', '.hidden')
    fire('rename', 'gone.csv')
    advance(WATCH_LIMITS.debounceMs)
    await settle()
    expect(woken).toHaveLength(1)
    const [wake] = woken
    expect(wake!.session).toBe('s-lin')
    expect(wake!.source).toEqual({ kind: 'futurebot', form: 'relay', type: 'evidence', job: 'w1', from: 'watch' })
    expect(wake!.text).toContain(`<evidence watch="w1" folder="${dir}">`)
    expect(wake!.text).toContain('- changed: day7.csv')
    expect(wake!.text).toContain('- changed: notes.txt')
    expect(wake!.text).toContain('- removed: gone.csv')
    expect(wake!.text).not.toContain('.hidden')
    expect(wake!.text).toContain('Why you are watching this folder: Day 7 counts land here.')
    expect(wake!.text).toContain('Nobody asked you anything')
  })

  it('takes changes made while the bot works, and their echoes, as its own', async () => {
    await watcher.add('lin', dir, '')
    const fire = listeners.get(dir)!
    busy = true
    fire('change', 'out.csv')
    busy = false
    advance(1000)
    fire('change', 'out.csv')
    advance(WATCH_LIMITS.debounceMs)
    await settle()
    expect(woken).toHaveLength(0)
    advance(WATCH_LIMITS.graceMs)
    fire('change', 'new.csv')
    advance(WATCH_LIMITS.debounceMs)
    await settle()
    expect(woken).toHaveLength(1)
  })

  it('wakes at most once a minute per folder, carrying the changes over', async () => {
    await watcher.add('lin', dir, '')
    const fire = listeners.get(dir)!
    fire('change', 'a.csv')
    advance(WATCH_LIMITS.debounceMs)
    await settle()
    fire('change', 'b.csv')
    advance(WATCH_LIMITS.debounceMs)
    await settle()
    expect(woken).toHaveLength(1)
    advance(WATCH_LIMITS.minGapMs)
    await settle()
    expect(woken).toHaveLength(2)
    expect(woken[1]!.text).toContain('b.csv')
  })

  it('validates folders, keeps a per-bot limit, and removes watches', async () => {
    await expect(watcher.add('lin', 'relative', '')).rejects.toBeInstanceOf(WatchError)
    await expect(watcher.add('lin', join(dir, 'missing'), '')).rejects.toThrow(/not an existing folder/)
    const first = await watcher.add('lin', dir, '')
    expect(await watcher.add('lin', `${dir}/`, '')).toEqual(first)
    expect(await watcher.remove('zhao', first.id)).toBe(false)
    expect(await watcher.remove('lin', first.id)).toBe(true)
    expect(closed).toEqual([dir])
    for (let i = 0; i < WATCH_LIMITS.perBot; i++) {
      const sub = await mkdtemp(join(dir, 'sub-'))
      await watcher.add('lin', sub, '')
    }
    await expect(watcher.add('lin', dir, '')).rejects.toThrow(/at most/)
    await watcher.removeBot('lin')
    expect(watcher.list('lin')).toEqual([])
  })

  it('reopens stored watches on start', async () => {
    await table.put('w9', { id: 'w9', bot: 'lin', path: dir, note: '', createdAt: stamp })
    watcher.start()
    expect(listeners.has(dir)).toBe(true)
    watcher.dispose()
    expect(closed).toEqual([dir])
  })
})
