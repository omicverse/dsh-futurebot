import { randomUUID } from 'node:crypto'
import { existsSync, statSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import type { Bot } from '../shared/types.ts'
import type { Table } from './mind.ts'

/**
 * Waking a bot on evidence rather than on a clock: a bot asks to watch a
 * folder; when files there change while the bot is idle, the plugin starts a
 * turn telling it what changed and why it was watching. Nobody asked it
 * anything, so the turn is the bot's own decision about whether its plans
 * change (the Perspective's third condition).
 */

export interface Watch {
  id: string
  bot: string
  path: string
  note: string
  createdAt: string
}

export interface EvidenceSource {
  kind: 'futurebot'
  form: 'relay'
  type: 'evidence'
  job: string
  from: 'watch'
}

export interface WatchPort {
  /** Start a turn in the bot's conversation with this text. */
  wake(sessionId: string, text: string, source: EvidenceSource): Promise<void>
  /** Whether the bot's conversation is running a turn right now. */
  busy(sessionId: string): boolean
}

export type WatchFn = (path: string, options: { recursive: boolean }, listener: (event: string, filename: string | null) => void) => Pick<FSWatcher, 'close' | 'on'>

export class WatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WatchError'
  }
}

export const WATCH_LIMITS = {
  perBot: 5,
  noteLength: 500,
  /** Changes are gathered this long before one wake. */
  debounceMs: 5000,
  /** At most one wake per watch in this window. */
  minGapMs: 60_000,
  /** Changes this soon after the bot was busy are taken as its own. */
  graceMs: 5000,
  wakesPerBotPerDay: 20,
  filesPerWake: 20,
} as const

export interface WatcherOptions {
  now?: () => number
  newId?: () => string
  watch?: WatchFn
  warn?: (message: string) => void
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface Live {
  handle: Pick<FSWatcher, 'close' | 'on'>
  pending: Map<string, string>
  timer?: unknown
  quietUntil: number
  lastWake: number
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export class Watcher {
  private readonly live = new Map<string, Live>()
  private readonly wakes = new Map<string, number[]>()
  private readonly now: () => number
  private readonly newId: () => string
  private readonly watchFn: WatchFn
  private readonly warn: (message: string) => void
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(
    private readonly table: Table<Watch>,
    private readonly port: WatchPort,
    private readonly botOf: (id: string) => Bot | undefined,
    options: WatcherOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => `w${randomUUID().replace(/-/g, '').slice(0, 10)}`)
    this.watchFn = options.watch ?? ((path, opts, listener) => fsWatch(path, opts, listener))
    this.warn = options.warn ?? (message => console.warn(`futurebot: ${message}`))
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  list(bot: string): Watch[] {
    return [...this.table.entries()].map(([, watch]) => watch).filter(watch => watch.bot === bot).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Open every stored watch; a folder that disappeared is reported and kept. */
  start(): void {
    for (const [, watch] of this.table.entries()) this.open(watch)
  }

  async add(bot: string, path: string, note: string): Promise<Watch> {
    // One folder, one watch: `/a/b/` and `/a/b` are the same place.
    const folder = normalize(path.trim()).replace(/(.)[\\/]+$/, '$1')
    if (!isAbsolute(folder)) throw new WatchError('path must be an absolute folder path')
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new WatchError(`${folder} is not an existing folder`)
    const mine = this.list(bot)
    const existing = mine.find(watch => watch.path === folder)
    if (existing !== undefined) return existing
    if (mine.length >= WATCH_LIMITS.perBot) throw new WatchError(`at most ${WATCH_LIMITS.perBot} watched folders; remove one first`)
    const text = note.trim()
    if (text.length > WATCH_LIMITS.noteLength) throw new WatchError(`note must be at most ${WATCH_LIMITS.noteLength} characters`)
    const watch: Watch = { id: this.newId(), bot, path: folder, note: text, createdAt: new Date(this.now()).toISOString() }
    await this.table.put(watch.id, watch)
    this.open(watch)
    return watch
  }

  async remove(bot: string, id: string): Promise<boolean> {
    const watch = this.table.get(id)
    if (watch === undefined || watch.bot !== bot) return false
    this.close(id)
    return this.table.delete(id)
  }

  /** Forget every watch of a bot that no longer exists. */
  async removeBot(bot: string): Promise<void> {
    for (const watch of this.list(bot)) await this.remove(bot, watch.id)
  }

  dispose(): void {
    for (const id of [...this.live.keys()]) this.close(id)
  }

  private open(watch: Watch): void {
    if (this.live.has(watch.id)) return
    try {
      const handle = this.watchFn(watch.path, { recursive: true }, (event, filename) => this.changed(watch.id, event, filename))
      handle.on('error', error => this.warn(`stopped watching ${watch.path}: ${String(error)}`))
      this.live.set(watch.id, { handle, pending: new Map(), quietUntil: 0, lastWake: 0 })
    } catch (error) {
      this.warn(`cannot watch ${watch.path}: ${String(error)}`)
    }
  }

  private close(id: string): void {
    const live = this.live.get(id)
    if (live === undefined) return
    if (live.timer !== undefined) this.clearTimer(live.timer)
    live.handle.close()
    this.live.delete(id)
  }

  private changed(id: string, event: string, filename: string | null): void {
    const watch = this.table.get(id)
    const live = this.live.get(id)
    if (watch === undefined || live === undefined || filename === null) return
    if (filename.split(/[\\/]/).some(part => part.startsWith('.'))) return
    const session = this.botOf(watch.bot)?.sessionId
    if (session === undefined) return
    const now = this.now()
    // A change while the bot works is its own doing, and so are the echoes right after.
    if (this.port.busy(session)) {
      live.quietUntil = now + WATCH_LIMITS.graceMs
      live.pending.clear()
      return
    }
    if (now < live.quietUntil) return
    live.pending.set(filename, event)
    if (live.timer === undefined) live.timer = this.setTimer(() => { void this.flush(id) }, WATCH_LIMITS.debounceMs)
  }

  private async flush(id: string): Promise<void> {
    const watch = this.table.get(id)
    const live = this.live.get(id)
    if (watch === undefined || live === undefined) return
    live.timer = undefined
    const session = this.botOf(watch.bot)?.sessionId
    if (session === undefined || live.pending.size === 0) return
    const now = this.now()
    if (this.port.busy(session)) {
      live.pending.clear()
      live.quietUntil = now + WATCH_LIMITS.graceMs
      return
    }
    if (now - live.lastWake < WATCH_LIMITS.minGapMs) {
      live.timer = this.setTimer(() => { void this.flush(id) }, WATCH_LIMITS.minGapMs - (now - live.lastWake))
      return
    }
    const today = (this.wakes.get(watch.bot) ?? []).filter(at => now - at < 86_400_000)
    if (today.length >= WATCH_LIMITS.wakesPerBotPerDay) {
      this.warn(`${watch.bot} reached ${WATCH_LIMITS.wakesPerBotPerDay} evidence wakes today; ignoring changes in ${watch.path}`)
      live.pending.clear()
      return
    }
    const files = [...live.pending.entries()]
    live.pending.clear()
    const lines = files.slice(0, WATCH_LIMITS.filesPerWake).map(([name, event]) => {
      const kind = event === 'change' ? 'changed' : existsSync(join(watch.path, name)) ? 'added' : 'removed'
      return `- ${kind}: ${name}`
    })
    if (files.length > WATCH_LIMITS.filesPerWake) lines.push(`- …and ${files.length - WATCH_LIMITS.filesPerWake} more`)
    const text = [
      `<evidence watch="${attr(watch.id)}" folder="${attr(watch.path)}">`,
      'Files changed while you were idle:',
      ...lines,
      ...(watch.note === '' ? [] : [`Why you are watching this folder: ${watch.note}`]),
      '</evidence>',
      '(Nobody asked you anything. Decide whether this changes your plans; if it does, act on it and record the change in your agenda with the reason.)',
    ].join('\n')
    live.lastWake = now
    this.wakes.set(watch.bot, [...today, now])
    try {
      await this.port.wake(session, text, { kind: 'futurebot', form: 'relay', type: 'evidence', job: watch.id, from: 'watch' })
    } catch (error) {
      this.warn(`could not wake about ${watch.path}: ${String(error)}`)
    }
  }
}
